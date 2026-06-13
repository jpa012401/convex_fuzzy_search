import { defineApp } from "convex/server";
import typesenseSearch from "@elevatech/typesense-search/convex.config.js";

const app = defineApp();
app.use(typesenseSearch, { httpPrefix: "/comments/" });

export default app;
