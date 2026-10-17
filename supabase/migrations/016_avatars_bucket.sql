-- 016_avatars_bucket.sql — the `avatars` bucket, which §3.6 has always named and nothing created.
--
-- ---------------------------------------------------------------------------------------------
-- WHY THIS FILE EXISTS
-- ---------------------------------------------------------------------------------------------
-- §3.6 头像上传 says verbatim: 「存 Supabase Storage `avatars` 桶；路径 `avatars/{user_id}.jpg`」.
-- `profile-update` has implemented exactly that since 1.0.1 —
-- `sb.storage.from("avatars").upload(`${userId}.jpg`, …)` — and 011 created `temp-shares` for
-- §1.2's shares in the same release, from the same kind of statement you are reading.
--
-- ⚠ NOBODY EVER CREATED `avatars`. The upload therefore failed with `Bucket not found`, which
-- `profile-update` deliberately answers as `INTERNAL` (its own message says
-- "Storage bucket 'avatars' does not exist"), and the operator saw 「服务端暂时出错，请稍后重试」 for
-- pressing 更换 on their own profile page.
--
-- This is the shape of defect that no suite in this project can see. The feature had a client half
-- (`GMProfile.compressAvatar`, `validateAvatar`, the picker wiring), a server half (`parseAvatarData`,
-- `uploadAvatar`), an error branch for the exact failure — and no bucket. The missing piece was not
-- code and not policy, so the static suites read a correct implementation, the behaviour suites stub
-- the network, and the diff reviewed clean. State created outside the migrations is state a re-run
-- does not reproduce.
--
-- `insert … on conflict` rather than a bare `insert`: `storage.buckets` is keyed on `id`, and a
-- re-run should converge on the intended shape instead of failing. 011 §5 spells the same insert
-- the long way for `temp-shares`; this one carries the two §3.6 limits as well, because they are
-- knowable here and are what the storage layer will enforce regardless.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ⚠ `public = true` IS THE READ HALF, AND IT IS WHY THERE IS NO read POLICY BELOW. A public bucket is
-- served from `/storage/v1/object/public/<bucket>/<path>`, an endpoint that does not consult
-- `storage.objects` RLS at all. That is the requirement rather than a shortcut: an avatar URL has to
-- work inside an `<img src>` on a page owned by somebody who is not the owner, and the cache in
-- front of it does not carry a JWT. Compare 011 §5, where `temp-shares` is PRIVATE and carries a
-- `is_activated()` policy — those bytes are §1.2.3's share payload; these are a profile picture that
-- §2.3.2's chat messages denormalise into every row they write.
--
-- ⚠ THE WRITE HALF HAS NO POLICY EITHER, AND THAT IS NOT AN OMISSION. Nothing writes here from a
-- client: `profile-update` uploads with the service role, which bypasses RLS by construction — the
-- same 「写只走 Edge Function」 split as the rest of the schema. A client INSERT/UPDATE policy would
-- be a second writer for a path only the server knows how to name (`{user_id}.jpg` is derived from
-- the verified token, never from the request body).
--
-- `file_size_limit` / `allowed_mime_types` restate §3.6's 「大小 ≤ 2MB」 and 「格式：jpg / png / webp」.
-- The same two rules also live in `GMProfile.validateAvatar` (so the operator is told before the
-- upload starts) and in `profile-update`'s `AVATAR_MAX_BYTES` / `AVATAR_TYPES` (because a client is
-- not a validator). Those three are NOT the 「一个答案两份实现」 shape this project bans: they answer
-- at three different layers. The first two exist to produce a SENTENCE for the operator; this one is
-- the platform's own gate, and it is the only one that still holds when the bytes do not come from
-- this client at all.
