/* Sankyo Chat version marker.
 * Bump APP_VERSION whenever you copy a new build onto the share. Running apps
 * re-load this file every few minutes and offer a reload when it changes. */
(function (root) {
  'use strict';
  var APP_VERSION = '1.12.0';
  var SC = root.SC = root.SC || {};
  if (!SC.VERSION) SC.VERSION = APP_VERSION;
  SC.LATEST_VERSION = APP_VERSION;
})(typeof window !== 'undefined' ? window : globalThis);
