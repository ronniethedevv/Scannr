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
  console.log('[Scannr Auth] signIn() called');

  const supabase = getSupabase();
  const redirectUrl = chrome.identity.getRedirectURL();

  console.log('[Scannr Auth] Redirect URL:', redirectUrl);
  console.log('[Scannr Auth] Requesting OAuth URL from Supabase (PKCE)...');

  // Step 1: Get the OAuth URL from Supabase (PKCE flow)
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'x',
    options: {
      redirectTo: redirectUrl,
      skipBrowserRedirect: true,
      queryParams: {
        prompt: 'consent',
      },
    },
  });

  console.log('[Scannr Auth] Supabase OAuth response:', JSON.stringify({ data, error }));

  if (error || !data?.url) {
    console.log('[Scannr Auth] FAILED — no OAuth URL returned');
    return { error: error?.message || 'Failed to start sign-in' };
  }

  console.log('[Scannr Auth] Launching launchWebAuthFlow with URL:', data.url);

  // Step 2: Open the auth URL in a browser popup
  try {
    const responseUrl = await chrome.identity.launchWebAuthFlow({
      url: data.url,
      interactive: true,
    });

    console.log('[Scannr Auth] launchWebAuthFlow callback fired');
    console.log('[Scannr Auth] responseUrl:', responseUrl);
    console.log('[Scannr Auth] lastError:', chrome.runtime.lastError);

    if (!responseUrl) {
      console.log('[Scannr Auth] No responseUrl — sign-in cancelled or failed');
      return { error: 'Sign-in was cancelled' };
    }

    // Step 3: PKCE flow — extract code from query params
    const url = new URL(responseUrl);
    const code = url.searchParams.get('code');

    console.log('[Scannr Auth] code present:', !!code);

    if (code) {
      // PKCE: exchange authorization code for session
      console.log('[Scannr Auth] Exchanging code for session...');
      const { data: sessionData, error: sessionError } =
        await supabase.auth.exchangeCodeForSession(code);

      if (sessionError) {
        console.log('[Scannr Auth] FAILED — exchangeCodeForSession error:', sessionError);
        return { error: sessionError.message };
      }

      console.log('[Scannr Auth] Signed in successfully (PKCE), user:', sessionData.user?.id);
      // Fire-and-forget: upsert profile + cache Ethos score
      if (sessionData.user) upsertUserProfile(sessionData.user).catch((err) => console.error('[Scannr Auth] upsertUserProfile failed:', err));
      return { user: sessionData.user };
    }

    // Fallback: check hash params (implicit flow)
    const hashParams = new URLSearchParams(url.hash.substring(1));
    const accessToken = hashParams.get('access_token');
    const refreshToken = hashParams.get('refresh_token');

    console.log('[Scannr Auth] Fallback — hash params keys:', [...hashParams.keys()]);
    console.log('[Scannr Auth] access_token present:', !!accessToken);
    console.log('[Scannr Auth] refresh_token present:', !!refreshToken);

    if (!accessToken || !refreshToken) {
      console.log('[Scannr Auth] FAILED — no code or tokens in redirect URL');
      return { error: 'Authentication failed — missing tokens' };
    }

    console.log('[Scannr Auth] Setting session from implicit tokens...');
    const { data: sessionData, error: sessionError } = await supabase.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });

    if (sessionError) {
      console.log('[Scannr Auth] FAILED — setSession error:', sessionError);
      return { error: sessionError.message };
    }

    console.log('[Scannr Auth] Signed in successfully (implicit), user:', sessionData.user?.id);
    // Fire-and-forget: upsert profile + cache Ethos score
    if (sessionData.user) upsertUserProfile(sessionData.user).catch((err) => console.error('[Scannr Auth] upsertUserProfile failed:', err));
    return { user: sessionData.user };

  } catch (err) {
    console.log('[Scannr Auth] EXCEPTION in OAuth flow:', err.message, err);
    return { error: err.message || 'Sign-in failed' };
  }
}

// ---------------------------------------------------------------------------
// Upsert User Profile + Ethos Score Cache
// ---------------------------------------------------------------------------

/**
 * Upsert user profile into the users table after sign-in,
 * then refresh Ethos score if stale or missing.
 */
async function upsertUserProfile(user) {
  console.log('[Scannr Auth] upsertUserProfile called for user:', user.id);
  const supabase = getSupabase();
  const meta = user.user_metadata || {};

  try {
    // Upsert profile from OAuth metadata
    const { error: upsertError } = await supabase.from('users').upsert({
      id: user.id,
      x_handle: meta.preferred_username || meta.user_name || null,
      x_display_name: meta.full_name || meta.name || null,
      x_avatar_url: meta.avatar_url || meta.picture || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'id' });

    if (upsertError) {
      console.error('[Scannr Auth] User profile upsert error:', JSON.stringify(upsertError));
    } else {
      console.log('[Scannr Auth] User profile upserted successfully');
    }
  } catch (err) {
    console.error('[Scannr Auth] User profile upsert exception:', err.message);
  }

  // Refresh Ethos score if stale or missing
  try {
    console.log('[Scannr Auth] Checking if Ethos score needs refresh...');

    const { data: profile, error: profileError } = await supabase
      .from('users')
      .select('ethos_score, ethos_updated_at')
      .eq('id', user.id)
      .single();

    if (profileError) {
      console.error('[Scannr Auth] Failed to read users table:', JSON.stringify(profileError));
      return;
    }

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const needsRefresh = !profile?.ethos_score
      || !profile?.ethos_updated_at
      || new Date(profile.ethos_updated_at) < sevenDaysAgo;

    console.log('[Scannr Auth] Current ethos_score:', profile?.ethos_score,
      'ethos_updated_at:', profile?.ethos_updated_at,
      'needs refresh:', needsRefresh);

    if (needsRefresh) {
      const handle = meta.preferred_username || meta.user_name;
      if (handle) {
        console.log('[Scannr Auth] Fetching Ethos score for handle:', handle);
        const ethosData = await fetchEthosScoreByHandle(handle);
        console.log('[Scannr Auth] Ethos API response:', JSON.stringify(ethosData));

        if (ethosData) {
          const { error: updateError } = await supabase.from('users').update({
            ethos_score: ethosData.score,
            ethos_level: ethosData.level,
            ethos_updated_at: new Date().toISOString(),
          }).eq('id', user.id);

          if (updateError) {
            console.error('[Scannr Auth] Ethos score update error:', JSON.stringify(updateError));
          } else {
            console.log('[Scannr Auth] Ethos score saved:', ethosData.score, ethosData.level);
          }
        } else {
          console.log('[Scannr Auth] No Ethos data returned — user may not have an Ethos profile');
        }
      } else {
        console.log('[Scannr Auth] No X handle available, skipping Ethos lookup');
      }
    }
  } catch (err) {
    console.error('[Scannr Auth] Ethos score fetch failed:', err.message, err);
  }
}

/**
 * Look up Ethos score by X handle using the userkey endpoint.
 * Single call: /api/v2/score/userkey?userkey=service:x.com:username:{handle}
 * Returns { score, level } or null if user has no Ethos profile (404).
 */
async function fetchEthosScoreByHandle(handle) {
  try {
    const cleanHandle = handle.replace(/^@/, '');
    const url = `https://api.ethos.network/api/v2/score/userkey?userkey=service:x.com:username:${cleanHandle}`;
    console.log('[Scannr Auth] Ethos score URL:', url);

    const response = await fetch(url, {
      headers: { 'X-Ethos-Client': 'scannr@1.0.0' },
      signal: AbortSignal.timeout(8000),
    });

    console.log('[Scannr Auth] Ethos score response status:', response.status);

    if (!response.ok) {
      console.warn('[Scannr Auth] Ethos score fetch failed:', response.status);
      return null;
    }

    const data = await response.json();
    console.log('[Scannr Auth] Ethos score data:', JSON.stringify(data));

    return {
      score: data.score || null,
      level: data.level || null,
    };
  } catch (err) {
    console.error('[Scannr Auth] Ethos score fetch error:', err.message);
    return null;
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

