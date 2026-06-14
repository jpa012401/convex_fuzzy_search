import { defineComponent } from "convex/server";
import aggregate from "@convex-dev/aggregate/convex.config";

const component = defineComponent("fuzzySearch");
component.use(aggregate, { name: "docCount" });
component.use(aggregate, { name: "sortIndex" });

export default component;
