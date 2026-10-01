#!/usr/bin/env python3
"""전북 면접사례 검색 앱 - 데이터 빌드 스크립트

사례목록 엑셀 + 문항 JSON + 사례별 PDF 를 합쳐 암호화된 앱 데이터(data/)를 만든다.

사용법 (앱 폴더에서):
    pip install cryptography openpyxl
    python tools/build.py --src "<연도 폴더>" [--src "<다른 연도 폴더>"] --password "비밀번호"

<연도 폴더> 구조 (예: 03_전북교육청 면접사례집(2026)):
    사례목록_<연도>_전체.xlsx        ← '전체목록' 시트
    사례별분할_<계열>/<파일명>.pdf
    json/<연도>_<계열>.json           ← 문항 추출 결과 (없어도 됨)

출력:
    data/meta.json        암호 확인용 정보(salt, 반복 횟수, 확인값)
    data/cases.bin        전체 사례 + 문항 (gzip → AES-256-GCM)
    data/pdf/cNNNN.bin    사례별 PDF (AES-256-GCM)
    data/.build-cache.json  변경 없는 PDF 재암호화 방지용 (git 에 올려도 무방)
"""
import argparse, base64, glob, gzip, hashlib, json, os, re, secrets, sys
from datetime import date

try:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    from cryptography.hazmat.primitives import hashes
    import openpyxl
except ImportError:
    sys.exit("필요한 패키지가 없습니다: pip install cryptography openpyxl")

MAGIC = b"JBE1"
ITER = 250_000
CHECK_PLAIN = b"jbe-interview-ok"
APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def derive(password: str, salt: bytes) -> bytes:
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=ITER)
    return kdf.derive(password.encode("utf-8"))


def enc(key: bytes, data: bytes) -> bytes:
    iv = secrets.token_bytes(12)
    return MAGIC + iv + AESGCM(key).encrypt(iv, data, None)


def dec(key: bytes, blob: bytes) -> bytes:
    assert blob[:4] == MAGIC
    return AESGCM(key).decrypt(blob[4:16], blob[16:], None)


def sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _pages(v):
    ns = [int(x) for x in re.findall(r"\d+", str(v or ""))]
    return [ns[0], ns[-1]] if ns else None


def load_list(src):
    xl = sorted(glob.glob(os.path.join(src, "사례목록_*_전체.xlsx")))
    if not xl:
        sys.exit(f"사례목록 엑셀을 찾지 못했습니다: {src}")
    ws = openpyxl.load_workbook(xl[-1], read_only=True, data_only=True)["전체목록"]
    rows = list(ws.iter_rows(values_only=True))
    head = [str(h).strip() if h else "" for h in rows[0]]
    col = {h: i for i, h in enumerate(head)}
    out = []
    for r in rows[1:]:
        fn = r[col["파일명"]]
        if not fn:
            continue
        pg = str(r[col["원본PDF 쪽"]] or "")
        a, _, b = pg.partition("~")
        out.append(dict(
            fn=fn, year=int(r[col["연도"]]), group=r[col["계열"]], gkey=fn.split("_")[1],
            univ=r[col["대학"]], dept=r[col["학과"]], adm=r[col["전형"]],
            src_pages=[int(a), int(b or a)] if a.isdigit() else None,
            npages=int(r[col["쪽수"]] or 0),
            book_pages=_pages(r[col["책자 쪽"]]) if "책자 쪽" in col else None,
            book_vol=str(r[col["책자 권"]] or "").strip() if "책자 권" in col else "",
        ))
    return out


def load_json(src):
    m = {}
    for jf in sorted(glob.glob(os.path.join(src, "json", "*.json"))):
        with open(jf, encoding="utf-8") as f:
            d = json.load(f)
        for c in d.get("cases", []):
            m[os.path.basename(c["pdf"])] = c
    return m


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", action="append", required=True, help="연도 폴더 (여러 번 지정 가능)")
    ap.add_argument("--password", required=True)
    ap.add_argument("--out", default=os.path.join(APP_DIR, "data"))
    ap.add_argument("--new-salt", action="store_true", help="비밀번호를 바꿀 때 사용 (모든 PDF 재암호화)")
    a = ap.parse_args()

    os.makedirs(os.path.join(a.out, "pdf"), exist_ok=True)
    meta_p = os.path.join(a.out, "meta.json")
    cache_p = os.path.join(a.out, ".build-cache.json")

    # salt: 같은 비밀번호면 재사용 → 바뀌지 않은 PDF 는 다시 암호화하지 않음
    salt = None
    if os.path.exists(meta_p) and not a.new_salt:
        meta = json.load(open(meta_p, encoding="utf-8"))
        s = base64.b64decode(meta["salt"])
        k = derive(a.password, s)
        try:
            dec(k, base64.b64decode(meta["check"]))
            salt, key = s, k
        except Exception:
            print("※ 비밀번호가 이전과 달라 새 salt 로 전체를 다시 암호화합니다.")
    if salt is None:
        salt = secrets.token_bytes(16)
        key = derive(a.password, salt)
    key_fp = hashlib.sha256(key).hexdigest()[:16]
    cache = json.load(open(cache_p, encoding="utf-8")) if os.path.exists(cache_p) else {}
    if cache.get("_key") != key_fp:
        cache = {"_key": key_fp}

    cases, used = [], set()
    n_q = n_json = n_pdf = n_enc = 0
    missing = []
    for src in a.src:
        lst, js = load_list(src), load_json(src)
        for it in lst:
            idx = len(cases) + 1
            cid = f"c{idx:04d}"
            c = js.get(it["fn"])
            pdf_path = os.path.join(src, f"사례별분할_{it['gkey']}", it["fn"])
            rec = {
                "id": cid, "year": it["year"], "group": it["group"], "gkey": it["gkey"],
                "univ": it["univ"], "dept": it["dept"], "adm": it["adm"],
                "fn": it["fn"], "srcPages": it["src_pages"], "npages": it["npages"],
                "pdf": None,
            }
            if it["book_pages"]:
                rec["bookPages"] = it["book_pages"]
            if it.get("book_vol"):
                rec["bookVol"] = it["book_vol"]
            if c:
                n_json += 1
                rec.update({
                    "bookPages": it["book_pages"] or c.get("pages", {}).get("book"),
                    "iv": c.get("interview", {}), "intro": c.get("intro_note", ""), "passage": c.get("passage", ""),
                    "qs": c.get("questions", []), "etc": c.get("etc", ""),
                })
                n_q += sum(1 + len(q.get("followups", [])) for q in rec["qs"])
            if os.path.exists(pdf_path):
                out_name = f"{cid}.bin"
                h = sha(pdf_path)
                out_file = os.path.join(a.out, "pdf", out_name)
                if cache.get(out_name) != h or not os.path.exists(out_file):
                    with open(pdf_path, "rb") as f:
                        blob = enc(key, f.read())
                    with open(out_file, "wb") as f:
                        f.write(blob)
                    cache[out_name] = h
                    n_enc += 1
                rec["pdf"] = f"data/pdf/{out_name}"
                used.add(out_name)
                n_pdf += 1
            else:
                missing.append(it["fn"])
            cases.append(rec)

    # 쓰이지 않는 옛 파일 정리
    for f in glob.glob(os.path.join(a.out, "pdf", "*.bin")):
        if os.path.basename(f) not in used:
            os.remove(f)
            cache.pop(os.path.basename(f), None)

    payload = {"built": date.today().isoformat(), "cases": cases,
               "stats": {"cases": len(cases), "withQ": n_json, "questions": n_q}}
    raw = gzip.compress(json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), 9)
    with open(os.path.join(a.out, "cases.bin"), "wb") as f:
        f.write(enc(key, raw))
    with open(meta_p, "w", encoding="utf-8") as f:
        json.dump({"v": 1, "kdf": "PBKDF2-SHA256", "iter": ITER,
                   "salt": base64.b64encode(salt).decode(),
                   "check": base64.b64encode(enc(key, CHECK_PLAIN)).decode(),
                   "built": payload["built"]}, f, ensure_ascii=False, indent=1)
    with open(cache_p, "w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False)

    print(f"사례 {len(cases)}건 (문항 정리 {n_json}건, 문항 {n_q}개) · PDF {n_pdf}개 (이번에 암호화 {n_enc}개)")
    if missing:
        print(f"※ PDF 없음 {len(missing)}건: " + ", ".join(missing[:5]) + (" …" if len(missing) > 5 else ""))


if __name__ == "__main__":
    main()
