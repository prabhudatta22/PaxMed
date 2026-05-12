import { randomSessionId } from "./phone.js";
import { getRedis } from "./redisClient.js";

const TTL_SECONDS = 5 * 60;

function keyForSid(sid) {
  return `paxmed:sp:sid:${sid}`;
}

export async function createProviderSession({ providerUserId, username }) {
  const r = await getRedis();
  if (!r) throw new Error("Redis not configured (set REDIS_URL)");
  const sid = randomSessionId();
  const payload = JSON.stringify({
    kind: "service_provider",
    provider_user_id: Number(providerUserId),
    username: String(username),
  });
  await r.set(keyForSid(sid), payload, { EX: TTL_SECONDS });
  return { sid, ttlSeconds: TTL_SECONDS };
}

export async function getProviderSession(sid) {
  const r = await getRedis();
  if (!r) return null;
  const raw = await r.get(keyForSid(String(sid)));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function deleteProviderSession(sid) {
  const r = await getRedis();
  if (!r) return;
  await r.del(keyForSid(String(sid)));
}

