/**
 * Scannr — Submission API
 *
 * CRUD operations for community flag/vouch submissions.
 * All operations require authentication (RLS enforced server-side).
 *
 * Table schema (Supabase):
 *   submissions (
 *     id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 *     user_id     uuid REFERENCES auth.users(id) NOT NULL,
 *     target_url  text NOT NULL,
 *     type        text CHECK (type IN ('flag', 'vouch')) NOT NULL,
 *     category         text,
 *     note             text,
 *     reporter_handle  text,
 *     created_at       timestamptz DEFAULT now()
 *   )
 *
 * RLS policies:
 *   - SELECT: any authenticated user can read all submissions
 *   - INSERT: authenticated users can insert their own (user_id = auth.uid())
 *   - UPDATE/DELETE: users can only modify their own submissions
 */

import { getSupabase } from './supabase.js';
import { createRateLimiter } from '../utils/rate-limiter.js';
import { logger } from '../utils/logger.js';
import { ENV } from '../config/env.js';

// Anti-abuse: max 10 submissions per 5 minutes per client
const submissionLimiter = createRateLimiter(10, 5 * 60_000);

// ---------------------------------------------------------------------------
// Submit a flag or vouch
// ---------------------------------------------------------------------------

/**
 * Submit a flag or vouch for a target URL.
 *
 * @param {'flag' | 'vouch'} type
 * @param {string} targetUrl — the tweet or account URL being reported
 * @param {string} [category] — e.g., 'phishing', 'scam', 'impersonation', 'legitimate'
 * @param {string} [note] — optional free-text note
 * @returns {Promise<{ data: object | null, error: string | null }>}
 */
export async function submitReport(type, targetUrl, category = null, note = null) {
  const supabase = getSupabase();

  // Anti-abuse: client-side rate limit
  if (!submissionLimiter.canCall()) {
    return { data: null, error: 'Rate limited — try again later' };
  }

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { data: null, error: 'Not signed in' };
  }

  submissionLimiter.record();

  // Read profile from users table (x_handle, ethos_score)
  const { data: profile } = await supabase
    .from('users')
    .select('x_handle, ethos_score')
    .eq('id', user.id)
    .single();

  // Fallback to auth metadata if users table row doesn't exist yet
  const reporterHandle = profile?.x_handle
    || user.user_metadata?.preferred_username
    || user.user_metadata?.user_name
    || null;

  const { data, error } = await supabase
    .from('submissions')
    .insert({
      user_id: user.id,
      target_url: targetUrl,
      type,
      category,
      note,
      reporter_handle: reporterHandle,
      reporter_ethos_score: profile?.ethos_score || null,
    })
    .select()
    .single();

  if (error) {
    logger.warn('Submission failed:', JSON.stringify(error));
    if (error.code === '23505') {
      return { data: null, error: 'Already submitted' };
    }
    return { data: null, error: error.message };
  }

  logger.info(`Submitted ${type} for ${targetUrl}`);

  // On-chain attestation via Edge Function (best-effort, non-blocking)
  // Uses the SUPABASE session token — NOT Privy. These are separate auth systems.
  try {
    const { data: { session: sbSession }, error: sessErr } = await supabase.auth.getSession();

    if (sessErr || !sbSession?.access_token) {
      console.warn('[Scannr] No Supabase session for attestation:', sessErr?.message || 'no token');
      return { data, error: null };
    }

    // Log token type (ES256 is current Supabase signing algorithm for this project)
    const tokenAlg = JSON.parse(atob(sbSession.access_token.split('.')[0])).alg;
    console.log('[Scannr] Token alg:', tokenAlg);

    const predicateKey = type === 'vouch'
      ? 'is_trustworthy'
      : (category === 'hacked_account' ? 'is_hacked_account'
        : category === 'wrong_link' ? 'is_wrong_link'
        : 'is_false_info');

    console.log('[Scannr] Calling attestation Edge Function — predicateKey:', predicateKey);

    fetch(ENV.ATTESTATION_FUNCTION_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': ENV.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${sbSession.access_token}`,
      },
      body: JSON.stringify({
        tweetUrl: targetUrl,
        predicateKey,
        userId: user.id,
      }),
    })
      .then(res => res.json().then(body => {
        console.log('[Scannr] Attestation response:', res.status, body);
      }))
      .catch(err => {
        console.error('[Scannr] Attestation fetch error:', err.message);
      });
  } catch (err) {
    console.error('[Scannr] Attestation setup error:', err.message);
  }

  return { data, error: null };
}

// ---------------------------------------------------------------------------
// Fetch submissions for a URL
// ---------------------------------------------------------------------------

/**
 * Get aggregated submission counts for a target URL.
 *
 * @param {string} targetUrl
 * @returns {Promise<{ flags: number, vouches: number, userSubmission: object | null }>}
 */
export async function getSubmissionsForUrl(targetUrl) {
  const supabase = getSupabase();

  // Get counts
  const { data: rows, error } = await supabase
    .from('submissions')
    .select('id, type, user_id, category, created_at')
    .eq('target_url', targetUrl);

  if (error) {
    logger.warn('Failed to fetch submissions:', error);
    return { flags: 0, vouches: 0, userSubmission: null };
  }

  const flags = rows.filter(r => r.type === 'flag').length;
  const vouches = rows.filter(r => r.type === 'vouch').length;

  // Check if current user already submitted
  let userSubmission = null;
  const { data: { user } } = await supabase.auth.getUser();
  if (user) {
    userSubmission = rows.find(r => r.user_id === user.id) || null;
  }

  return { flags, vouches, userSubmission };
}

// ---------------------------------------------------------------------------
// Fetch submissions in batch (for multiple URLs)
// ---------------------------------------------------------------------------

/**
 * Get submission counts for multiple URLs in a single query.
 *
 * @param {string[]} urls
 * @returns {Promise<Map<string, { flags: number, vouches: number }>>}
 */
export async function getSubmissionsBatch(urls) {
  const supabase = getSupabase();
  const results = new Map();

  if (urls.length === 0) return results;

  const { data: rows, error } = await supabase
    .from('submissions')
    .select('target_url, type')
    .in('target_url', urls);

  if (error) {
    logger.warn('Batch submissions fetch failed:', error);
    return results;
  }

  // Initialize all URLs
  for (const url of urls) {
    results.set(url, { flags: 0, vouches: 0 });
  }

  // Count
  for (const row of rows) {
    const entry = results.get(row.target_url);
    if (entry) {
      if (row.type === 'flag') entry.flags++;
      else if (row.type === 'vouch') entry.vouches++;
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Delete own submission
// ---------------------------------------------------------------------------

/**
 * Delete the current user's submission for a URL (undo flag/vouch).
 *
 * @param {string} submissionId
 * @returns {Promise<{ ok: boolean, error: string | null }>}
 */
export async function deleteSubmission(submissionId) {
  const supabase = getSupabase();

  const { error } = await supabase
    .from('submissions')
    .delete()
    .eq('id', submissionId);

  if (error) {
    logger.warn('Delete submission failed:', error);
    return { ok: false, error: error.message };
  }

  return { ok: true, error: null };
}
