// No-op placeholder for the demo's nav-bar chrome (the "Live demo" badge + the
// first-run intro dialog). The daemon build ships this stub — production never
// bundles any demo UI. The frontend-only demo build aliases this module to
// web/demo/demo-chrome.tsx (see scripts/build-demo.ts), swapping in the real one.
export function DemoChrome() {
  return null;
}
