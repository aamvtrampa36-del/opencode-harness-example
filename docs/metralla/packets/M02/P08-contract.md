# P08 — Remote RPC/MCP contract (offline)
P07 handoff 94973933b8649dfd548cc5680d56ca779e92cc42, receipt a36ef603fb043774a2bda33638af07f7c4325ec6; CI 45516890734 exact source 33fc338d9e24a290cfb1b08e5a67d85e489d5660. B0 837dce9b283f6b4b0b2ba939407883ec95be726a. Public standard Ubuntu Actions only; no paid runner, no secrets, no live calls or deployment.
## Catalog matrix
Observed connector 21 tools vs source 24 registerTool entries (B0 and runtime historical source blob 390984950ce1e7d5ef59873cdbde2e4a3444604e). R=read declared, X=effect or unknown, U=unavailable. I=hex16, W=UUID optional, S=session.
|staging_ suffix|schema B0|catalog/dispatch|
|---|---|---|
|status|{}|R health + status|
|reconcile|{}|X absent, reconciliation|
|models|{}|R models|
|repositories|{}|R repositories|
|sessions|W|R directory|
|session_inspect|W,S|R inspection|
|mcp_servers|{}|R discovery|
|mcp_tools|server|X unknown transitively, discovery only|
|mcp_call|server,name,args|X dynamic tool|
|diagnostics|limit 1–64|R catalog omits limit|
|agent_check|model,kind|X inference/Linux|
|agent_check_status|{}|R status|
|openrouter_check|{}|X inference/Linux|
|openrouter_check_status|{}|R status|
|start_task|I,prompt,repository,model,W,S,mode,pins|X even read_only; catalog omits mode and pins|
|task_status|I,W|R ledger snapshot, never legacy mutating status|
|task_artifacts|I|R manifest, absent|
|capture_task_artifact|I,path,name,mime|X Linux/persist, absent|
|task_progress|I,W,after|U legacy unbounded SDK; catalog incorrectly advertises available|
|task_continue|I,W,turnId,prompt|X continue|
|task_select_model|I,W,model|X model|
|cancel_task|I,W|X cancel|
|review_task|I,W|X review|
|task_transcript|I,W|U refused, catalog advertises 20 messages|
## P08 delta
Versioned optional schema opencode.remote-evidence.v1 on status and progress; afterRevision safe int or omitted, cursor signed P07 token <=2048 chars, no numeric nonzero after in v1. Old worker or schema mismatch returns error, never downgrades. Legacy progress stays unavailable and never advances cursor. Status is snapshot not native proof. RPC consumer checks identity, sequence, revision, bounds, page completeness and denies false passed/verified. HTTP POST cap 64KiB before parser, 5s read, no compressed body; GET/DELETE/SSE unchanged. Transport chunks already allocated upstream not bounded by this layer. No retry.
P07 integration fixture uses projectedProgress with signed cursor bound to digest of authenticated principal + exact task, workspace and session. Authorize callback MUST be from trusted backend, must verify task ownership before source access and use existing key and atomic coverage. Derived principal must be used consistently by source index adapter; M08 can adapt storage scope to authenticated original principal without exposing cursor digest as user input. A reasoning event is replaced by event.omitted to preserve contiguous sequence. No raw history/log fallback. P07 row byte/timeout and source coverage still required. Versioned methods remoteSupervisorStatusV1(id,afterRevision) and remoteSupervisorProgressV1(id,cursor) are optional and fail closed until M08 integrates shared DO server.ts; no actual auth/global permissions change. Backend status needs authoritative durable revision, exact scope and bounded ledger snapshot; no new table or live data. MCP server.ts here is owned src/staging-control-mcp/server.ts, not shared src/server.ts. Backend hunk contract: on fixed and custom workspace after assertStagingRemote + authoritative principal/task binding, call projectRemoteProgress with P07 source and existing key; return exact scope; for status return schema,id,workspace,revision,status from bounded authoritative row. Do not add methods until coverage and key management verified; never call legacy native status or raw SDK log. M08 must produce exact shared hunk at integrated SHA and certify real backend auth/coverage. M07 cannot interpret logical progress as native activity, closure or verified result.
