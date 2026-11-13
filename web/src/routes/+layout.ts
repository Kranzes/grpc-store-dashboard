// A static SPA: every route is an empty prerendered shell that mounts in the browser.
export const ssr = false;
export const prerender = true;
// <dir>/index.html for every page, which the farm's Envoy serves at /<dir>/.
export const trailingSlash = 'always';
