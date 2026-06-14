import { defineApp } from "convex/server";
import fuzzySearch from "@elevatech/fuzzy-search/convex.config.js";

const app = defineApp();
app.use(fuzzySearch);

export default app;
