import { assertChannelsOnlySql, withLibpqSslCompat } from "./client";

assertChannelsOnlySql("SELECT id FROM connection");
assertChannelsOnlySql("SELECT id FROM channels.connection");

let denied = false;
try {
  assertChannelsOnlySql("SELECT 1 FROM public.auth_user");
} catch {
  denied = true;
}
if (!denied) throw new Error("expected public schema SQL to be denied");

const compat = withLibpqSslCompat(
  "postgresql://channels_app:x@host:5432/devjewels?sslmode=require",
);
if (!compat.includes("uselibpqcompat=true")) {
  throw new Error("expected uselibpqcompat on sslmode=require URLs");
}
if (
  withLibpqSslCompat("postgresql://x@host/db?uselibpqcompat=true") !==
  "postgresql://x@host/db?uselibpqcompat=true"
) {
  throw new Error("expected existing uselibpqcompat to be left alone");
}

denied = false;
try {
  assertChannelsOnlySql("SELECT 1 FROM diamond.diamond_listing");
} catch {
  denied = true;
}
if (!denied) throw new Error("expected diamond schema SQL to be denied");

console.log("assertChannelsOnlySql self-check ok");
