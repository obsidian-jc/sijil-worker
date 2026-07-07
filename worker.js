/**
 * 원베일리 시설일지 — 노션 DB + GitHub 동시 저장 프록시 (Cloudflare Worker)
 *
 * 역할:
 *  - 브라우저는 CORS 정책 때문에 api.notion.com / api.github.com을 직접 호출할 수 없습니다.
 *  - 이 Worker가 대신 호출해주고, 토큰은 Worker의 시크릿에만 저장됩니다.
 *  - 웹앱(GitHub Pages 등 정적 사이트)은 이 Worker의 URL만 알면 됩니다.
 *
 * ── 이번에 바뀐 것 ──
 *  - /notion-inbox 가 이제 "받은편지함 페이지에 글머리 기호로 추가"하는 대신,
 *    "시설관리일지" 데이터베이스에 구조화된 항목(날짜/구분/내용)으로 새 페이지를 생성합니다.
 *  - form.html에서 보내는 category 값(todo/task/contact/history/docs/inbox)을
 *    데이터베이스의 "구분" 속성(일지/메모/할일)으로 매핑합니다.
 *  - /notion-inbox 응답에 생성된 페이지 id(notion.pageId)를 포함해서,
 *    뒤이어 오는 /notion-photo 요청이 그 페이지에 사진을 바로 첨부할 수 있게 했습니다.
 *  - GitHub(옵시디언) 저장은 기존과 동일하게 독립적으로 계속 작동합니다.
 *
 * ── 필요한 환경변수 (wrangler secret / vars) ──
 *  NOTION_TOKEN          (secret) 노션 통합 토큰
 *  NOTION_DB_ID           (var) "시설관리일지" 데이터베이스 ID
 *  PHOTO_PARENT_PAGE_ID   (var) targetPageId가 없을 때 쓸 대체용 사진 부모 페이지 ID
 *  ALLOWED_ORIGIN         (var, 선택) CORS 허용 origin
 *
 *  GITHUB_TOKEN   (secret) GitHub Personal Access Token (해당 저장소 Contents 쓰기 권한)
 *  GITHUB_REPO    (var) 예: "obsidian-jc/memo"
 *  GITHUB_BRANCH  (var, 선택, 기본 "main")
 *  GITHUB_DIR     (var, 선택, 기본 "받은편지함") 마크다운을 커밋할 폴더
 *
 * 배포 방법은 README.md 참고.
 */
const NOTION_VERSION = '2022-06-28';

// form.html의 카테고리 key → 데이터베이스 "구분" 속성 값 매핑
// (데이터베이스엔 일지/메모/할일 3개만 있어서, 폰 앱의 6개 카테고리를 이 셋으로 합쳐 넣음)
const CATEGORY_TO_TYPE = {
  todo: '할일',
  task: '일지',
  contact: '메모',
  history: '일지',
  docs: '메모',
  inbox: '메모',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(env) });
    }

    if (url.pathname === '/notion-inbox' && request.method === 'POST') {
      return handleInbox(request, env);
    }

    if (url.pathname === '/notion-photo' && request.method === 'POST') {
      return handlePhoto(request, env);
    }

    if (url.pathname === '/health') {
      return json({ ok: true }, 200, env);
    }

    // 점검용: 실제 배포된 워커에 환경변수가 제대로 들어갔는지 브라우저로 바로 확인
    // (토큰 값 자체는 절대 노출하지 않고, 있는지/길이만 보여줌)
    if (url.pathname === '/debug') {
      return json({
        hasNotionToken: !!env.NOTION_TOKEN,
        hasNotionDbId: !!env.NOTION_DB_ID,
        hasPhotoParentPageId: !!env.PHOTO_PARENT_PAGE_ID,
        hasGithubToken: !!env.GITHUB_TOKEN,
        githubTokenLength: env.GITHUB_TOKEN ? env.GITHUB_TOKEN.length : 0,
        githubRepo: env.GITHUB_REPO || null,
        githubBranch: env.GITHUB_BRANCH || null,
        githubDir: env.GITHUB_DIR || null,
      }, 200, env);
    }

    return json({ error: 'not found' }, 404, env);
  },
};

// ══════════════════════════════════════════════════════
// 받은편지함 텍스트 저장 (노션 DB + GitHub)
// ══════════════════════════════════════════════════════
async function handleInbox(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: '잘못된 요청 본문입니다.' }, 400, env);
  }

  const text = (body.text || '').toString();
  const categoryKey = (body.category || 'inbox').toString();

  if (!text) return json({ error: 'text가 필요합니다.' }, 400, env);
  if (text.length > 1900) return json({ error: '내용이 너무 깁니다 (2000자 제한).' }, 400, env);

  // ── 1) 노션 데이터베이스에 구조화된 항목으로 저장 ──
  let notionResult = { ok: false, error: 'NOTION_TOKEN/NOTION_DB_ID 미설정' };
  if (env.NOTION_TOKEN && env.NOTION_DB_ID) {
    notionResult = await saveToNotionDatabase(text, categoryKey, env);
  }

  // ── 2) GitHub(옵시디언) 저장 — 노션 성패와 무관하게 독립 시도 ──
  let githubResult = { ok: false, error: 'GITHUB_TOKEN 미설정' };
  if (env.GITHUB_TOKEN && env.GITHUB_REPO) {
    githubResult = await appendToDailyNote(text, env);
  }
  console.log('[GITHUB DEBUG]', JSON.stringify({
    hasToken: !!env.GITHUB_TOKEN,
    tokenLen: env.GITHUB_TOKEN ? env.GITHUB_TOKEN.length : 0,
    repo: env.GITHUB_REPO,
    branch: env.GITHUB_BRANCH,
    dir: env.GITHUB_DIR,
    result: githubResult,
  }));

  const overallOk = notionResult.ok || githubResult.ok;
  return json({ ok: overallOk, notion: notionResult, github: githubResult }, overallOk ? 200 : 502, env);
}

// "시설관리일지" 데이터베이스에 새 페이지(항목)를 생성
async function saveToNotionDatabase(text, categoryKey, env) {
  try {
    const dateStr = todayDateKST();
    const type = CATEGORY_TO_TYPE[categoryKey] || '메모';
    const titleText = text.length > 60 ? text.slice(0, 60) + '…' : text;

    const res = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.NOTION_TOKEN}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        parent: { database_id: env.NOTION_DB_ID },
        properties: {
          '제목': { title: [{ text: { content: titleText } }] },
          '날짜': { date: { start: dateStr } },
          '구분': { select: { name: type } },
          '내용': { rich_text: [{ text: { content: text } }] },
        },
      }),
    });
    const resultText = await res.text();
    if (!res.ok) {
      return { ok: false, error: `노션 API 오류 (${res.status})`, detail: safeJsonParse(resultText) };
    }
    const created = JSON.parse(resultText);
    return { ok: true, pageId: created.id, type };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// KST 기준 오늘 날짜의 일일노트(md)에 한 줄을 이어붙임 (없으면 새로 생성)
async function appendToDailyNote(line, env) {
  const dateStr = todayDateKST();
  const dir = (env.GITHUB_DIR || '받은편지함').replace(/\/$/, '');
  const path = `${dir}/${dateStr}.md`;
  const branch = env.GITHUB_BRANCH || 'main';

  try {
    // 1) 기존 파일 조회 (있으면 sha + 기존 내용 필요)
    const getUrl = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${encodeGithubPath(path)}?ref=${branch}`;
    const getRes = await fetch(getUrl, { headers: githubHeaders(env) });

    let sha = undefined;
    let newContent;
    if (getRes.status === 200) {
      const existing = await getRes.json();
      sha = existing.sha;
      const decoded = b64DecodeUtf8(existing.content.replace(/\n/g, ''));
      newContent = decoded + `- ${line}\n`;
    } else if (getRes.status === 404) {
      newContent = buildDailyNoteHeader(dateStr) + `- ${line}\n`;
    } else {
      const t = await getRes.text();
      return { ok: false, error: `GitHub 조회 실패 (${getRes.status})`, detail: t };
    }

    // 2) 생성/업데이트 커밋
    const putRes = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/contents/${encodeGithubPath(path)}`, {
      method: 'PUT',
      headers: { ...githubHeaders(env), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `시설일지: ${dateStr} 기록 추가`,
        content: b64EncodeUtf8(newContent),
        branch,
        ...(sha ? { sha } : {}),
      }),
    });
    if (!putRes.ok) {
      const t = await putRes.text();
      return { ok: false, error: `GitHub 커밋 실패 (${putRes.status})`, detail: safeJsonParse(t) };
    }
    return { ok: true, path };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function buildDailyNoteHeader(dateStr) {
  return `---\ntype: 일일기록\ndate: ${dateStr}\ntags: [시설일지, 받은편지함]\n---\n\n# ${dateStr}\n\n`;
}

// ══════════════════════════════════════════════════════
// 사진 저장 (노션 + GitHub)
// ══════════════════════════════════════════════════════
async function handlePhoto(request, env) {
  let form;
  try {
    form = await request.formData();
  } catch (e) {
    return json({ error: '잘못된 요청 본문입니다 (multipart/form-data 필요).' }, 400, env);
  }

  const caption = (form.get('caption') || '').toString();
  const targetPageId = (form.get('targetPageId') || '').toString().trim();
  const file = form.get('file');
  if (!file || typeof file === 'string') return json({ error: 'file이 필요합니다.' }, 400, env);

  const MAX_BYTES = 20 * 1024 * 1024;
  if (file.size > MAX_BYTES) {
    return json({ error: `파일이 너무 큽니다 (${Math.round(file.size / 1024 / 1024)}MB). 20MB 이하만 지원합니다.` }, 400, env);
  }

  const fileBuf = await file.arrayBuffer();

  // ── 1) 노션 저장: targetPageId가 있으면 그 항목(방금 생성된 DB 페이지)에 바로 첨부,
  //     없으면 예전처럼 날짜별 사진 모음 페이지에 첨부 ──
  let notionResult = { ok: false, error: 'NOTION_TOKEN 미설정' };
  if (env.NOTION_TOKEN) {
    notionResult = await savePhotoToNotion(file, fileBuf, caption, targetPageId, env);
  }

  // ── 2) GitHub 저장 ──
  let githubResult = { ok: false, error: 'GITHUB_TOKEN 미설정' };
  if (env.GITHUB_TOKEN && env.GITHUB_REPO) {
    githubResult = await savePhotoToGithub(file, fileBuf, env);
  }

  const overallOk = notionResult.ok || githubResult.ok;
  return json({ ok: overallOk, notion: notionResult, github: githubResult }, overallOk ? 200 : 502, env);
}

async function savePhotoToNotion(file, fileBuf, caption, targetPageId, env) {
  const notionHeaders = { Authorization: `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': NOTION_VERSION };
  try {
    let pageId = targetPageId;
    if (!pageId) {
      if (!env.PHOTO_PARENT_PAGE_ID) return { ok: false, error: 'targetPageId도 없고 PHOTO_PARENT_PAGE_ID도 미설정' };
      pageId = await findOrCreateTodayPhotoPage(env);
    }

    const createRes = await fetch('https://api.notion.com/v1/file_uploads', {
      method: 'POST',
      headers: { ...notionHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const createText = await createRes.text();
    if (!createRes.ok) return { ok: false, error: `업로드 슬롯 생성 실패 (${createRes.status})`, detail: safeJsonParse(createText) };
    const fileUploadId = JSON.parse(createText).id;

    const sendForm = new FormData();
    sendForm.append('file', new Blob([fileBuf], { type: file.type }), file.name || 'photo.jpg');
    const sendRes = await fetch(`https://api.notion.com/v1/file_uploads/${fileUploadId}/send`, {
      method: 'POST', headers: notionHeaders, body: sendForm,
    });
    const sendText = await sendRes.text();
    if (!sendRes.ok) return { ok: false, error: `업로드 전송 실패 (${sendRes.status})`, detail: safeJsonParse(sendText) };

    const isVideo = (file.type || '').startsWith('video/');
    const blockType = isVideo ? 'video' : 'image';
    const attachRes = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children`, {
      method: 'PATCH',
      headers: { ...notionHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        children: [{
          object: 'block', type: blockType,
          [blockType]: { type: 'file_upload', file_upload: { id: fileUploadId }, ...(caption ? { caption: [{ text: { content: caption } }] } : {}) },
        }],
      }),
    });
    const attachText = await attachRes.text();
    if (!attachRes.ok) return { ok: false, error: `사진 첨부 실패 (${attachRes.status})`, detail: safeJsonParse(attachText) };
    return { ok: true, fileUploadId, pageId };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function savePhotoToGithub(file, fileBuf, env) {
  const dir = (env.GITHUB_DIR || '받은편지함').replace(/\/$/, '') + '/photos';
  const branch = env.GITHUB_BRANCH || 'main';
  const ts = todayTimestampKST();
  const safeName = (file.name || 'photo.jpg').replace(/[^\w.\-가-힣]/g, '_');
  const path = `${dir}/${ts}_${safeName}`;
  try {
    const base64 = arrayBufferToBase64(fileBuf);
    const putRes = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/contents/${encodeGithubPath(path)}`, {
      method: 'PUT',
      headers: { ...githubHeaders(env), 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `시설일지: 사진 추가 ${safeName}`, content: base64, branch }),
    });
    if (!putRes.ok) {
      const t = await putRes.text();
      return { ok: false, error: `GitHub 사진 커밋 실패 (${putRes.status})`, detail: safeJsonParse(t) };
    }
    return { ok: true, path };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function findOrCreateTodayPhotoPage(env) {
  const notionHeaders = { Authorization: `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': NOTION_VERSION };
  const title = todayTitleKST();
  let cursor = undefined;
  for (let i = 0; i < 5; i++) {
    const qs = cursor ? `?start_cursor=${cursor}&page_size=100` : `?page_size=100`;
    const listRes = await fetch(`https://api.notion.com/v1/blocks/${env.PHOTO_PARENT_PAGE_ID}/children${qs}`, { headers: notionHeaders });
    if (!listRes.ok) throw new Error(`children 조회 실패: ${listRes.status}`);
    const list = await listRes.json();
    const found = (list.results || []).find((b) => b.type === 'child_page' && b.child_page && b.child_page.title === title);
    if (found) return found.id;
    if (!list.has_more) break;
    cursor = list.next_cursor;
  }
  const createRes = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: { ...notionHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ parent: { page_id: env.PHOTO_PARENT_PAGE_ID }, properties: { title: { title: [{ text: { content: title } }] } } }),
  });
  if (!createRes.ok) { const t = await createRes.text(); throw new Error(`페이지 생성 실패: ${createRes.status} ${t}`); }
  return (await createRes.json()).id;
}

// ══════════════════════════════════════════════════════
// 유틸
// ══════════════════════════════════════════════════════
function githubHeaders(env) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'sijil-worker',
  };
}
// GitHub Contents API는 경로의 '/'는 그대로 두고, 각 구간만 개별적으로 인코딩해야 함
// (encodeURIComponent(fullPath)를 그대로 쓰면 '/'까지 %2F로 바뀌어 경로가 깨짐)
function encodeGithubPath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}
function todayDateKST() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return `${kst.getUTCFullYear()}-${String(kst.getUTCMonth() + 1).padStart(2, '0')}-${String(kst.getUTCDate()).padStart(2, '0')}`;
}
// 사진 파일명용: "2026-07-05_17-20-33" 형태 (밀리초 타임스탬프보다 사람이 읽기 좋음)
function todayTimestampKST() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const y = kst.getUTCFullYear(), mo = String(kst.getUTCMonth() + 1).padStart(2, '0'), d = String(kst.getUTCDate()).padStart(2, '0');
  const h = String(kst.getUTCHours()).padStart(2, '0'), mi = String(kst.getUTCMinutes()).padStart(2, '0'), s = String(kst.getUTCSeconds()).padStart(2, '0');
  return `${y}-${mo}-${d}_${h}-${mi}-${s}`;
}
function todayTitleKST() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const y = kst.getUTCFullYear(), m = String(kst.getUTCMonth() + 1).padStart(2, '0'), d = String(kst.getUTCDate()).padStart(2, '0');
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  return `${y}-${m}-${d}(${days[kst.getUTCDay()]})_시설일지 사진`;
}
function b64EncodeUtf8(str) { return btoa(unescape(encodeURIComponent(str))); }
function b64DecodeUtf8(b64) { return decodeURIComponent(escape(atob(b64))); }
function arrayBufferToBase64(buf) {
  let binary = '';
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
function corsHeaders(env) {
  const allowOrigin = env.ALLOWED_ORIGIN || '*';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}
function json(obj, status, env) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...corsHeaders(env) } });
}
function safeJsonParse(s) { try { return JSON.parse(s); } catch (e) { return s; } }
