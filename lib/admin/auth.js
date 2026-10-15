/**
 * lib/admin/auth.js
 *
 * Admin authentication verification and MAC regular expression.
 * Kept strictly under 250 lines.
 */

import { timingSafeCompare } from '../../api/poll.js';

export const MAC_REGEX = /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/;

/**
 * Extracts and verifies the admin credentials from request headers, query string, or body.
 *
 * @param {object} req - HTTP request object
 * @param {string} expectedSecret - Configured admin secret or password
 * @returns {boolean} - True if authenticated, false otherwise
 */
export function checkAdminAuth(req, expectedSecret) {
  if (!req || typeof req !== 'object') return false;
  if (!expectedSecret || typeof expectedSecret !== 'string') return false;

  const authHeader = req.headers?.['authorization'] || '';
  const customHeader = req.headers?.['x-admin-password'] || req.headers?.['x-admin-secret'] || '';

  let candidate = '';

  if (typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
    candidate = authHeader.slice(7).trim();
  } else if (typeof customHeader === 'string' && customHeader.trim()) {
    candidate = customHeader.trim();
  } else if (req.url) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const querySecret = url.searchParams.get('password') || url.searchParams.get('secret');
      if (querySecret) candidate = querySecret.trim();
    } catch {
      // Ignore URL parsing errors
    }
  }

  if (!candidate && req.body && typeof req.body === 'object' && req.body.password) {
    candidate = String(req.body.password).trim();
  }

  return candidate ? timingSafeCompare(candidate, expectedSecret) : false;
}
