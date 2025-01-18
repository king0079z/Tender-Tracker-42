import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import compression from 'compression';
import pg from 'pg';
const { Client } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;

// Enable gzip compression
app.use(compression());
app.use(express.json());

// Database connection management
let dbClient = null;
let isConnected = false;
let connectionRetries = 0;
const MAX_RETRIES = 5;
const RETRY_DELAY = 5000;

const createClient = () => {
  console.log('Creating new database client...');
  return new Client({
    host: process.env.VITE_AZURE_DB_HOST || 'tender-tracking-db2.postgres.database.azure.com',
    database: process.env.VITE_AZURE_DB_NAME || 'postgres',
    user: process.env.VITE_AZURE_DB_USER || 'abouefletouhm@tender-tracking-db2', // Updated username with server name
    password: process.env.VITE_AZURE_DB_PASSWORD || process.env.AZURE_POSTGRESQL_PASSWORD,
    port: 5432,
    ssl: {
      rejectUnauthorized: false
    },
    connectionTimeoutMillis: 30000,
    query_timeout: 30000
  });
};

const connectDB = async () => {
  if (isConnected) return true;

  try {
    if (dbClient) {
      console.log('Closing existing client...');
      await dbClient.end().catch(() => {});
    }

    console.log('Initializing new database connection...');
    dbClient = createClient();
    await dbClient.connect();
    isConnected = true;
    connectionRetries = 0;
    console.log('Successfully connected to database');
    return true;
  } catch (error) {
    console.error('Database connection error:', error);
    console.error('Error details:', {
      code: error.code,
      message: error.message,
      stack: error.stack
    });
    
    isConnected = false;
    dbClient = null;

    if (connectionRetries < MAX_RETRIES) {
      connectionRetries++;
      console.log(`Retrying connection (${connectionRetries}/${MAX_RETRIES}) in ${RETRY_DELAY}ms...`);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      return connectDB();
    } else {
      console.log('Max connection retries reached, continuing without database');
      return false;
    }
  }
};

// Health check endpoint
app.get('/api/health', async (req, res) => {
  try {
    const health = {
      status: 'healthy',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      database: isConnected ? 'connected' : 'disconnected',
      environment: {
        nodeEnv: process.env.NODE_ENV,
        port: PORT,
        dbHost: process.env.VITE_AZURE_DB_HOST,
        dbName: process.env.VITE_AZURE_DB_NAME
      }
    };

    if (isConnected) {
      try {
        await dbClient.query('SELECT 1');
        health.database = 'connected';
      } catch (dbError) {
        console.error('Database health check failed:', dbError);
        health.database = 'error';
        health.databaseError = dbError.message;
        
        // Try to reconnect if database connection failed
        connectDB();
      }
    }

    // Return 200 even if database is not connected to prevent container restarts
    res.status(200).json(health);
  } catch (error) {
    // Return 200 to prevent container restarts, but include error details
    res.status(200).json({
      status: 'degraded',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Database query endpoint
app.post('/api/query', async (req, res) => {
  if (!isConnected) {
    return res.status(503).json({
      error: true,
      message: 'Database not connected'
    });
  }

  try {
    const { text, params } = req.body;
    
    if (!text) {
      return res.status(400).json({
        error: true,
        message: 'Query text is required'
      });
    }

    console.log('Executing query:', text);
    console.log('Query parameters:', params);

    const result = await dbClient.query(text, params);
    console.log('Query executed successfully');

    res.json({
      rows: result.rows,
      rowCount: result.rowCount,
      fields: result.fields?.map(f => ({
        name: f.name,
        dataType: f.dataTypeID
      }))
    });
  } catch (error) {
    console.error('Query error:', error);
    console.error('Error details:', {
      code: error.code,
      message: error.message,
      stack: error.stack
    });
    
    if (error.code === 'ECONNRESET' || error.code === '57P01') {
      isConnected = false;
      connectDB();
    }
    
    res.status(500).json({ 
      error: true,
      message: error.message,
      code: error.code,
      detail: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Serve static files
app.use(express.static(join(__dirname, 'dist')));

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'dist', 'index.html'));
});

// Graceful shutdown
const shutdown = async () => {
  console.log('Shutting down gracefully...');
  if (dbClient) {
    try {
      await dbClient.end();
      console.log('Database connection closed');
    } catch (error) {
      console.error('Error closing database connection:', error);
    }
  }
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Initialize server
const startServer = async () => {
  try {
    // Start the server first
    const server = app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      console.log(`Health check available at: http://localhost:${PORT}/api/health`);
      console.log('Environment:', {
        nodeEnv: process.env.NODE_ENV,
        port: PORT,
        dbHost: process.env.VITE_AZURE_DB_HOST,
        dbName: process.env.VITE_AZURE_DB_NAME
      });
    });

    // Then attempt database connection
    const dbConnected = await connectDB();
    if (!dbConnected) {
      console.log('Server started without database connection');
    }

    return server;
  } catch (error) {
    console.error('Failed to start server:', error);
    console.error('Error details:', {
      code: error.code,
      message: error.message,
      stack: error.stack
    });
    process.exit(1);
  }
};

startServer();