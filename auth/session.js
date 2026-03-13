/**
 * Scannr — Auth Session Manager
 *
 * Handles "Sign in with X" via Supabase OAuth + chrome.identity.
 * Flow:
 *   1. Call Supabase signInWithOAuth({ provider: 'twitter' }) to get the auth URL
 *   2. Open that URL via chrome.identity.launchWebAuthFlow
 *   3. Supabase redirects back with tokens in the URL fragment
 *   4. Extract tokens, call supabase.auth.setSession()
 *   5. Persist via chrome.storage.local adapter (handled by Supabase client)
 *
 * The redirect URL uses chrome.identity.getRedirectURL() which returns
 * https://<extension-id>.chromiumapp.org/ — must be added to Supabase
 * dashboard under Authentication → URL Configuration → Redirect URLs.
 */

import { getSupabase } from '../api/supabase.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Sign In
// ---------------------------------------------------------------------------

/**
 * Launch "Sign in with X" OAuth flow.
 * @returns {Promise<{ user: object } | { error: string }>}
 */
export async function signIn() {
  const supabase = getSupabase();
  const redirectUrl = chrome.identity.getRedirectURL();

  // Step 1: Get the OAuth URL from Supabase
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'twitter',
    options: {
      redirectTo: redirectUrl,
      skipBrowserRedirect: true, // we handle the redirect ourselves
    },
  });

  if (error || !data?.url) {
    logger.warn('Failed to get OAuth URL:', error);
    return { error: error?.message || 'Failed to start sign-in' };
  }

  // Step 2: Open the auth URL in a browser popup
  try {
    const responseUrl = await chrome.identity.launchWebAuthFlow({
      url: data.url,
      interactive: true,
    });

    if (!responseUrl) {
      return { error: 'Sign-in was cancelled' };
    }

    // Step 3: Extract tokens from the redirect URL fragment
    const hashParams = extractHashParams(responseUrl);
    const accessToken = hashParams.get('access_token');
    const refreshToken = hashParams.get('refresh_token');

    if (!accessToken || !refreshToken) {
      logger.warn('Missing tokens in redirect URL');
      return { error: 'Authentication failed — missing tokens' };
    }

    // Step 4: Set the session in Supabase client
    const { data: sessionData, error: sessionError } = await supabase.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });

    if (sessionError) {
      logger.warn('Failed to set session:', sessionError);
      return { error: sessionError.message };
    }

    logger.info('Signed in successfully');
    return { user: sessionData.user };

  } catch (err) {
    logger.warn('OAuth flow error:', err);
    return { error: err.message || 'Sign-in failed' };
  }
}

// ---------------------------------------------------------------------------
// Sign Out
// ---------------------------------------------------------------------------

export async function signOut() {
  const supabase = getSupabase();
  const { error } = await supabase.auth.signOut();
  if (error) {
    logger.warn('Sign-out error:', error);
    return { error: error.message };
  }
  logger.info('Signed out');
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Session State
// ---------------------------------------------------------------------------

/**
 * Get the current user if signed in.
 * @returns {Promise<{ user: object | null }>}
 */
export async function getUser() {
  const supabase = getSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  return { user };
}

/**
 * Get the current session (includes tokens).
 * @returns {Promise<{ session: object | null }>}
 */
export async function getSession() {
  const supabase = getSupabase();
  const { data: { session } } = await supabase.auth.getSession();
  return { session };
}

/**
 * Listen for auth state changes.
 * @param {function} callback — (event, session) => void
 * @returns {object} subscription with unsubscribe()
 */
export function onAuthStateChange(callback) {
  const supabase = getSupabase();
  const { data: { subscription } } = supabase.auth.onAuthStateChange(callback);
  return subscription;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractHashParams(url) {
  const hashIndex = url.indexOf('#');
  if (hashIndex === -1) return new URLSearchParams();
  return new URLSearchParams(url.substring(hashIndex + 1));
}
