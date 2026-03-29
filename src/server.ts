/**
 * @file server.ts
 * @description Server entry point
 * Starts the Express server and handles graceful shutdown
 */

import http from "http";
import "dotenv/config"; // Load environment variables

// App configuration
import createApp from "./app";
import logger from "./config/logger";
import { setupGlobalErrorHandlers } from "./utils/unhandledRejectionHandler";

// Background jobs
import { startJobs, stopJobs } from "./jobs";

// Services initialization
import { initializePinecone } from "./config/pinecone";
import { testSupabaseConnection } from "./config/supabase";
import { storageService } from "./services/storage.service";

/**
 * Server port configuration
 */
const PORT = parseInt(process.env.PORT || "3001", 10);

/**
 * Initialize all services
 */
const initializeServices = async (): Promise<void> => {
  // Setup global error handlers first
  setupGlobalErrorHandlers();

  logger.info("Initializing services...");

  try {
    // Test Supabase connection
    logger.info("Testing Supabase connection...");
    const isSupabaseConnected = await testSupabaseConnection();
    if (isSupabaseConnected) {
      logger.info("Supabase connection successful");
    } else {
      logger.warn("Supabase connection unavailable; continuing with limited functionality");
    }

    // Initialize Pinecone
    logger.info("Initializing Pinecone vector database...");
    await initializePinecone();
    logger.info("Pinecone initialized successfully");

    // Test Supabase Storage connection
    logger.info("Testing Supabase Storage connection...");
    const storageTest = await storageService.testStorageConnection();
    if (!storageTest.success) {
      logger.warn("Supabase Storage test failed", { error: storageTest.error });
      logger.warn(
        "Avatar uploads may not work. Please check bucket 'avatars' exists in Supabase Storage."
      );
    } else {
      logger.info("Supabase Storage connection successful");
    }

    if (isSupabaseConnected) {
      // Start background jobs only when the backing datastore is reachable.
      logger.info("Starting background jobs...");
      startJobs();
      logger.info("Background jobs started");
    } else {
      logger.warn("Skipping background jobs because Supabase is unavailable");
    }

    logger.info("All services initialized successfully");
  } catch (error) {
    logger.error("Failed to initialize services", {
      error: error instanceof Error ? error.message : "Unknown error",
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }
};

/**
 * Start the server
 */
const startServer = async (): Promise<http.Server> => {
  try {
    // Create Express app
    const app = createApp();

    // Create HTTP server
    const server = http.createServer(app);

    // Initialize services
    await initializeServices();

    // Start listening on port 3001
    server.listen(PORT, () => {
      logger.info(`🚀 Server is running on port ${PORT}`, {
        port: PORT,
        environment: process.env.NODE_ENV || "development",
        nodeVersion: process.version,
        timestamp: new Date().toISOString(),
      });

      if (process.env.NODE_ENV === "development") {
        logger.info(`📡 API available at: http://localhost:${PORT}/api`);
        logger.info(`💚 Health check: http://localhost:${PORT}/api/health`);
      }
    });

    // Handle server errors
    server.on("error", (error: NodeJS.ErrnoException) => {
      if (error.syscall !== "listen") {
        throw error;
      }

      const bind = `Port ${PORT}`;

      switch (error.code) {
        case "EACCES":
          logger.error(`${bind} requires elevated privileges`);
          process.exit(1);
          break;
        case "EADDRINUSE":
          logger.error(`${bind} is already in use. Please kill the process using this port.`);
          logger.error("Run: netstat -ano | findstr :3001");
          logger.error("Then: taskkill /PID <PID> /F");
          process.exit(1);
          break;
        default:
          throw error;
      }
    });

    return server;
  } catch (error) {
    logger.error("Failed to start server", {
      error: error instanceof Error ? error.message : "Unknown error",
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  }
};

/**
 * Graceful shutdown handler
 */
const gracefulShutdown = async (server: http.Server, signal: string): Promise<void> => {
  logger.info(`${signal} received, starting graceful shutdown...`);

  try {
    // Stop accepting new connections
    server.close(() => {
      logger.info("HTTP server closed");
    });

    // Stop background jobs
    logger.info("Stopping background jobs...");
    await stopJobs();
    logger.info("Background jobs stopped");

    // Force exit after timeout
    setTimeout(() => {
      logger.warn("Force exit after timeout");
      process.exit(0);
    }, 3000);

    logger.info("Graceful shutdown completed");
    process.exit(0);
  } catch (error) {
    logger.error("Error during graceful shutdown", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
    process.exit(1);
  }
};

/**
 * Handle unhandled promise rejections
 */
process.on("unhandledRejection", (reason: Error | unknown, promise: Promise<unknown>) => {
  logger.error("Unhandled Promise Rejection", {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
    promise: promise,
  });

  // In production, you might want to exit the process
  if (process.env.NODE_ENV === "production") {
    process.exit(1);
  }
});

/**
 * Handle uncaught exceptions
 */
process.on("uncaughtException", (error: Error) => {
  logger.error("Uncaught Exception", {
    error: error.message,
    stack: error.stack,
  });

  // Always exit on uncaught exception
  process.exit(1);
});

/**
 * Start the server and setup shutdown handlers
 */
const main = async (): Promise<void> => {
  const server = await startServer();

  // Register shutdown handlers
  process.on("SIGTERM", () => gracefulShutdown(server, "SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown(server, "SIGINT"));
};

// Run the server
main().catch((error) => {
  logger.error("Fatal error during server startup", {
    error: error instanceof Error ? error.message : "Unknown error",
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});
