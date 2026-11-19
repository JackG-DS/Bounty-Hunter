'use client';

import { createAuthClient } from '@neondatabase/auth/next';

export const authClient = createAuthClient();

export interface NeonAuthUser {
  id: string;
  email: string | null;
  name?: string | null;
}

export interface NeonAuthSession {
  id?: string;
  token?: string;
  user: NeonAuthUser;
}

function extractErrorMessage(err: unknown, fallback = 'Authentication failed'): string {
  if (!err) return fallback;
  if (typeof err === 'object') {
    const anyErr = err as {
      error?: { message?: string; statusText?: string };
      message?: string;
      statusText?: string;
    };
    if (anyErr.error?.message) return anyErr.error.message;
    if (anyErr.message) return anyErr.message;
    if (anyErr.statusText) return anyErr.statusText;
  }
  return String(err);
}

// Get Active Neon Auth Session
export async function getAuthSession(): Promise<NeonAuthSession | null> {
  try {
    const res = await authClient.getSession();
    const data = (
      res as unknown as {
        data?: { user?: NeonAuthUser; session?: { id?: string; token?: string } } | null;
      }
    )?.data;
    if (!data?.user?.id) {
      return null;
    }
    return {
      id: data.session?.id,
      token: data.session?.token,
      user: {
        id: data.user.id,
        email: data.user.email || null,
        name: data.user.name || null,
      },
    };
  } catch (err) {
    console.warn('[NeonAuth] getSession exception:', err);
    return null;
  }
}

// Email / Password Sign Up via Neon Auth
export async function signUpWithEmail(
  email: string,
  password: string,
  name?: string
): Promise<{ user: NeonAuthUser | null; session: NeonAuthSession | null; error: Error | null }> {
  try {
    const displayName = (name || email.split('@')[0] || 'Bounty Hunter').trim();
    const res = await authClient.signUp.email({
      email: email.trim(),
      password,
      name: displayName,
    });
    const anyRes = res as unknown as {
      data?: { user?: NeonAuthUser; session?: { id?: string; token?: string } } | null;
      error?: { message?: string } | null;
    };
    if (anyRes?.error) {
      return {
        user: null,
        session: null,
        error: new Error(anyRes.error.message || 'Sign-up failed'),
      };
    }
    const userObj = anyRes?.data?.user;
    if (!userObj?.id) {
      const session = await getAuthSession();
      if (session?.user) {
        return { user: session.user, session, error: null };
      }
      return { user: null, session: null, error: new Error('Sign-up did not return a user') };
    }
    const user: NeonAuthUser = {
      id: userObj.id,
      email: userObj.email || email.trim(),
      name: userObj.name || displayName,
    };
    const session: NeonAuthSession = {
      id: anyRes?.data?.session?.id,
      token: anyRes?.data?.session?.token,
      user,
    };
    return { user, session, error: null };
  } catch (err) {
    return {
      user: null,
      session: null,
      error: new Error(extractErrorMessage(err, 'Failed to create account')),
    };
  }
}

// Email / Password Sign In via Neon Auth
export async function signInWithEmail(
  email: string,
  password: string
): Promise<{ user: NeonAuthUser | null; session: NeonAuthSession | null; error: Error | null }> {
  try {
    const res = await authClient.signIn.email({
      email: email.trim(),
      password,
    });
    const anyRes = res as unknown as {
      data?: { user?: NeonAuthUser; session?: { id?: string; token?: string } } | null;
      error?: { message?: string } | null;
    };
    if (anyRes?.error) {
      return {
        user: null,
        session: null,
        error: new Error(anyRes.error.message || 'Sign-in failed'),
      };
    }
    const userObj = anyRes?.data?.user;
    if (!userObj?.id) {
      const session = await getAuthSession();
      if (session?.user) {
        return { user: session.user, session, error: null };
      }
      return { user: null, session: null, error: new Error('Invalid email or password') };
    }
    const user: NeonAuthUser = {
      id: userObj.id,
      email: userObj.email || email.trim(),
      name: userObj.name || null,
    };
    const session: NeonAuthSession = {
      id: anyRes?.data?.session?.id,
      token: anyRes?.data?.session?.token,
      user,
    };
    return { user, session, error: null };
  } catch (err) {
    return {
      user: null,
      session: null,
      error: new Error(extractErrorMessage(err, 'Invalid email or password')),
    };
  }
}

// Sign Out via Neon Auth
export async function signOutUser(): Promise<{ error: Error | null }> {
  try {
    await authClient.signOut();
    return { error: null };
  } catch (err) {
    return { error: new Error(extractErrorMessage(err, 'Sign-out failed')) };
  }
}

// Get Current User via Neon Auth
export async function getCurrentAuthUser(): Promise<NeonAuthUser | null> {
  const session = await getAuthSession();
  return session?.user || null;
}
