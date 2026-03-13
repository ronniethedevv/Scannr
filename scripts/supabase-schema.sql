-- Scannr — Supabase Database Schema
-- Run this in the Supabase SQL Editor to set up the required tables and policies.
-- Updated: March 2026

-- =========================================================================
-- 1. Submissions Table
-- =========================================================================

CREATE TABLE IF NOT EXISTS submissions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES auth.users(id) NOT NULL,
  target_url  text NOT NULL,
  type        text CHECK (type IN ('flag', 'vouch')) NOT NULL,
  category    text,
  note        text,
  created_at  timestamptz DEFAULT now()
);

-- Index for fast lookups by target URL
CREATE INDEX IF NOT EXISTS idx_submissions_target_url ON submissions(target_url);

-- Index for user's own submissions
CREATE INDEX IF NOT EXISTS idx_submissions_user_id ON submissions(user_id);

-- Unique constraint: one submission per user per URL
CREATE UNIQUE INDEX IF NOT EXISTS idx_submissions_user_url
  ON submissions(user_id, target_url);

-- =========================================================================
-- 2. Row Level Security (RLS)
-- =========================================================================

ALTER TABLE submissions ENABLE ROW LEVEL SECURITY;

-- Anyone authenticated can read all submissions
CREATE POLICY "Authenticated users can read submissions"
  ON submissions FOR SELECT
  TO authenticated
  USING (true);

-- Users can only insert their own submissions
CREATE POLICY "Users can insert own submissions"
  ON submissions FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

-- Users can only update their own submissions
CREATE POLICY "Users can update own submissions"
  ON submissions FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Users can only delete their own submissions
CREATE POLICY "Users can delete own submissions"
  ON submissions FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- =========================================================================
-- 3. Rate Limiting (server-side, via database function)
-- =========================================================================

-- Function to check if a user has exceeded the submission rate limit
-- Returns true if the user can submit, false if rate limited
CREATE OR REPLACE FUNCTION check_submission_rate_limit(p_user_id uuid)
RETURNS boolean AS $$
DECLARE
  recent_count integer;
BEGIN
  SELECT COUNT(*) INTO recent_count
  FROM submissions
  WHERE user_id = p_user_id
    AND created_at > now() - interval '5 minutes';

  RETURN recent_count < 10; -- max 10 submissions per 5 minutes
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =========================================================================
-- 4. Supabase Auth Configuration (manual steps)
-- =========================================================================
--
-- In the Supabase Dashboard:
--
-- A) Authentication → Providers → Twitter (X)
--    - Enable Twitter provider
--    - Add your Twitter OAuth 2.0 Client ID and Secret
--    - Callback URL: https://<your-project>.supabase.co/auth/v1/callback
--
-- B) Authentication → URL Configuration
--    - Add redirect URL: https://<extension-id>.chromiumapp.org/
--    - (Get extension ID from chrome://extensions after loading the extension)
--
-- C) Update config/env.js with your project URL and anon key:
--    - SUPABASE_URL: https://<your-project>.supabase.co
--    - SUPABASE_ANON_KEY: <your-anon-key>
