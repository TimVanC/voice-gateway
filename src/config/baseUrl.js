// src/config/baseUrl.js
// Dynamic base URL configuration for Railway production and local dev

const isProd = process.env.NODE_ENV === "production";

const BASE_URL = (
  isProd 
    ? process.env.PUBLIC_BASE_URL 
    : process.env.LOCAL_PUBLIC_BASE_URL
) || "http://localhost:8080";

// Validate URL format
if (!/^https?:\/\/.+/i.test(BASE_URL)) {
  console.warn(`⚠️  BASE_URL may be invalid: "${BASE_URL}"`);
}

module.exports = { BASE_URL, isProd };

