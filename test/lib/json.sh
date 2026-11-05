#!/usr/bin/env bash
# json.sh -- jq readers for the report CLI's machine-readable output.
# Sourced by test/e2e-cli.sh. Bash 3.2 compatible.
#
# The CLI contract (specs/worker-series + design §15) promises machine-readable
# output but does not freeze every field path, so these readers search the JSON
# recursively by value (body / id / token) instead of hard-coding one shape.

if [ -n "${_REPORT_E2E_JSON_SOURCED:-}" ]; then
  return 0
fi
_REPORT_E2E_JSON_SOURCED=1

json_get() {
  # json_get <file> <jq-path> [jq args...]
  local f=$1 path=$2
  shift 2
  jq -r "$@" "($path) // empty" "$f" 2>/dev/null || true
}

json_has_sub() {
  # json_has_sub <file> <substring> : true if any JSON string contains it.
  jq -s -e --arg s "$2" '[.[] | .. | strings] | map(contains($s)) | index(true) != null' \
    "$1" >/dev/null 2>&1
}

json_count_with_sub() {
  # json_count_with_sub <file> <substring> : number of JSONL documents that
  # contain the substring (works for a single JSON doc too).
  jq -s --arg s "$2" \
    '[.[] | select(([.. | strings] | map(contains($s)) | index(true)) != null)] | length' \
    "$1" 2>/dev/null || true
}

json_line_count() {
  jq -s 'length' "$1" 2>/dev/null || true
}

json_posts_length() {
  # Timeline/search payloads: number of posts (summaries have no body).
  jq -r 'if (.posts? | type) == "array" then (.posts | length) else 0 end' "$1" 2>/dev/null || true
}

json_seq_ok() {
  # Every delivered event has a numeric top-level seq, non-decreasing.
  jq -s -e '
    (length > 0)
    and (all(.[]; (.seq | type) == "number"))
    and ([.[].seq] as $s
         | (reduce range(1; ($s | length)) as $i (true; . and ($s[$i - 1] <= $s[$i]))))
  ' "$1" >/dev/null 2>&1
}

json_seq_csv() {
  jq -s -r '[.[] | .seq // empty] | join(",")' "$1" 2>/dev/null || true
}

json_post_id() {
  # json_post_id <file> <body-substring>: id of the object carrying that body.
  jq -r --arg b "$2" '
    [ .. | objects
      | select(.id != null)
      | select((((.body // .body_md // .text) // "") | contains($b)))
      | .id ]
    | if (length > 0) then .[0] else empty end
  ' "$1" 2>/dev/null | sed -n '1p' || true
}

json_post_id_from_result() {
  # Post/commit results use summarizePost (id + author, NO body). Do not fall
  # back to "first ULID": the top-level batch_id is a ULID too and sorts first
  # in document order.
  jq -r '
    [ .. | objects | select(.id != null and (.author? != null)) | .id ]
    | .[0] // empty
  ' "$1" 2>/dev/null || true
}

json_first_ulid() {
  # Post ids are ULIDs (design §5). Fallback only; account ids are slugs.
  jq -r '.. | strings | select(test("^[0-9A-HJKMNP-TV-Z]{26}$"))' "$1" 2>/dev/null \
    | sed -n '1p' || true
}

json_post_fields() {
  # json_post_fields <file> <body-substring> -> TSV:
  #   id  parent_id  root_id  self_thread_id  i  n
  # Duplicated renderings of the same post are de-duplicated by id.
  jq -s -r --arg b "$2" '
    [ .[] | .. | objects
      | select(.id != null)
      | select((((.body // .body_md // .text) // "") | contains($b))) ]
    | unique_by(.id)
    | .[]
    | [ .id,
        (.parent_id // .parentId // ""),
        (.root_id // .rootId // ""),
        (.self_thread_id // .selfThreadId // ""),
        ((.i // "") | tostring),
        ((.n // "") | tostring) ]
    | @tsv
  ' "$1" 2>/dev/null || true
}

json_in_pairs() {
  # Distinct "i/n" values anywhere in the thread payload.
  jq -s -r '
    [ .[] | .. | objects
      | select((.i? != null) and (.n? != null))
      | "\(.i)/\(.n)" ]
    | unique
    | .[]
  ' "$1" 2>/dev/null || true
}

json_access_token() {
  # Login response: accept accessToken / access_token / token, or any v1.* string.
  local f=$1 t=""
  t=$(jq -r '
    [ .. | objects
      | (.accessToken? // .access_token? // .token? // empty)
      | select(type == "string" and length > 0) ]
    | .[0] // empty
  ' "$f" 2>/dev/null || true)
  if [ -z "$t" ]; then
    t=$(jq -r '.. | strings | select(test("^v1\\."))' "$f" 2>/dev/null | sed -n '1p' || true)
  fi
  printf '%s' "$t"
}

json_draft_id() {
  # Best-effort draft id from `draft ls` output.
  local f=$1 acct=${2:-} id=""
  if [ -n "$acct" ]; then
    id=$(jq -s -r --arg a "$acct" '
      [ .[] | .. | objects | select(.id != null and ((.author? // "") == $a)) | .id ]
      | .[0] // empty
    ' "$f" 2>/dev/null || true)
  fi
  if [ -z "$id" ]; then
    id=$(jq -s -r '[ .[] | .. | objects | .id? // empty ] | .[0] // empty' "$f" 2>/dev/null || true)
  fi
  printf '%s' "$id"
}

json_draft_present() {
  # True when `draft ls` reports at least one draft object.
  jq -s -e '
    [ .[] | .. | objects
      | select(has("items") or has("item_count") or has("itemCount")
               or has("count") or has("draft_id") or has("draftId")) ]
    | length > 0
  ' "$1" >/dev/null 2>&1
}

json_server_field() {
  # json_server_field <data-dir> <field>
  json_get "$1/server.json" ".$2"
}

# json_post_fields_by_id <file> <post-id> -> TSV: id parent_id root_id self_thread_id i n
# Exact-id lookup (body-substring matching is ambiguous when texts repeat).
json_post_fields_by_id() {
  jq -s -r --arg id "$2" '
    [ .[] | .. | objects | select(.id == $id) ] | unique_by(.id) | .[0]
    | [ .id,
        (.parent_id // .parentId // ""),
        (.root_id // .rootId // ""),
        (.self_thread_id // .selfThreadId // ""),
        ((.i // "") | tostring),
        ((.n // "") | tostring) ]
    | join("|")
  ' "$1"
}
