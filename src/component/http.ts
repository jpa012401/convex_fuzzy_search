import { httpRouter } from "convex/server";

const http = httpRouter();

// HTTP routes for the component are registered here.
// The component currently exposes no HTTP routes; all access is via the
// query/mutation API. This router is kept as the registration point for any
// future routes (and because _generated/api.ts references it).

export default http;
