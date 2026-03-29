import "dotenv/config";
import fs from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";

const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!accessToken) {
  throw new Error("SUPABASE_ACCESS_TOKEN is required to apply schema via Management API");
}

if (!supabaseUrl) {
  throw new Error("SUPABASE_URL is required");
}

if (!serviceRoleKey) {
  throw new Error("SUPABASE_SERVICE_ROLE_KEY is required");
}

const projectRef = new URL(supabaseUrl).hostname.split(".")[0];
const sqlFilePath = path.resolve(__dirname, "init-supabase-schema.sql");
const query = fs.readFileSync(sqlFilePath, "utf8");

const applySchema = async (): Promise<void> => {
  const response = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      read_only: false,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to apply schema: ${response.status} ${response.statusText} - ${errorText}`);
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  const { data: buckets, error: bucketListError } = await supabaseAdmin.storage.listBuckets();
  if (bucketListError) {
    throw new Error(`Schema applied but failed to list buckets: ${bucketListError.message}`);
  }

  const hasUserUploads = (buckets || []).some((bucket) => bucket.name === "user-uploads");
  if (!hasUserUploads) {
    const { error: createBucketError } = await supabaseAdmin.storage.createBucket("user-uploads", {
      public: true,
      fileSizeLimit: 10485760,
      allowedMimeTypes: [
        "image/jpeg",
        "image/png",
        "image/webp",
        "application/pdf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "text/plain",
        "text/markdown",
        "video/mp4",
      ],
    });

    if (createBucketError) {
      throw new Error(`Schema applied but failed to create user-uploads bucket: ${createBucketError.message}`);
    }
  }

  console.log("Supabase schema applied successfully.");
};

applySchema().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});