import { assertChannelsOnlySql } from "./client";

assertChannelsOnlySql("SELECT id FROM connection");
assertChannelsOnlySql("SELECT id FROM channels.connection");

let denied = false;
try {
  assertChannelsOnlySql("SELECT 1 FROM public.auth_user");
} catch {
  denied = true;
}
if (!denied) throw new Error("expected public schema SQL to be denied");

denied = false;
try {
  assertChannelsOnlySql("SELECT 1 FROM diamond.diamond_listing");
} catch {
  denied = true;
}
if (!denied) throw new Error("expected diamond schema SQL to be denied");

console.log("assertChannelsOnlySql self-check ok");
