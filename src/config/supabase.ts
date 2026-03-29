/**
 * @file supabase.ts
 * @description Supabase client configuration
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import logger from "./logger";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Missing Supabase credentials");
}

/**
 * Supabase client for public operations (with RLS)
 */
export const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

/**
 * Supabase admin client for privileged operations (bypasses RLS)
 */
export const supabaseAdmin: SupabaseClient = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
);

/**
 * Test Supabase connection
 */
export const testSupabaseConnection = async (): Promise<boolean> => {
  try {
    // Test connection by querying a real table that we know exists
    const { error } = await supabaseAdmin.from("agents").select("id").limit(1);

    // Log the actual error for debugging
    if (error) {
      logger.error("Supabase query error details", {
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint,
      });

      // Only throw if it's not a "no rows" error
      if (error.code !== "PGRST116") {
        throw error;
      }
    }

    logger.info("Supabase connection test successful");
    return true;
  } catch (error) {
    const errorCode =
      error instanceof Error && "code" in error
        ? (error as Error & { code: string }).code
        : undefined;

    logger.error("Supabase connection test failed", {
      error: error instanceof Error ? error.message : "Unknown error",
      errorCode,
      hint: "Check your SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env file",
    });

    // Don't throw - allow server to start even if Supabase is not configured yet
    logger.warn("Server starting without Supabase connection");
    return false;
  }
};

export default supabaseAdmin;
