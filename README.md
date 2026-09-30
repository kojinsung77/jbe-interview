# 전북 면접사례 검색

전북특별자치도교육청 대입 면접사례모음집을 대학·학과·질문 키워드로 찾고, 원본 사례 PDF를 바로 여는 교내 상담용 웹앱입니다.

- 정적 사이트(HTML·CSS·JS)라서 GitHub Pages에 그대로 올리면 됩니다.
- 사례 데이터와 PDF는 **모두 AES-256으로 암호화**되어 올라갑니다. 비밀번호를 모르면 파일을 내려받아도 읽을 수 없습니다.

## 폴더 구조

```
index.html
assets/app.js, assets/style.css
data/meta.json          ← 비밀번호 확인용 정보 (암호문)
data/cases.bin          ← 전체 사례 + 문항 (암호문)
data/pdf/c0001.bin …    ← 사례별 PDF (암호문)
tools/build.py          ← 데이터 빌드 스크립트
```

## 데이터 다시 만들기 (문항 JSON 추가, 연도 추가, 비밀번호 변경)

```bash
pip install cryptography openpyxl
python tools/build.py --src "…/03_전북교육청 면접사례집(2026)" --password "비밀번호"
# 연도가 여러 개면 --src 를 여러 번
python tools/build.py --src "…(2026)" --src "…(2025)" --password "비밀번호"
```

- `--src` 폴더에는 `사례목록_<연도>_전체.xlsx`, `사례별분할_<계열>/*.pdf`, `json/*.json` 이 있어야 합니다.
- 같은 비밀번호로 다시 빌드하면 **바뀐 PDF만** 다시 암호화합니다(git 변경량 최소화).
- 비밀번호를 바꾸면 모든 PDF가 새로 암호화되고, 이전 비밀번호와 "이 기기에서 기억하기"는 무효가 됩니다.

## GitHub Pages 배포

1. GitHub에 새 저장소를 만들고 이 폴더 전체를 올립니다 (`data/` 포함).
2. 저장소 **Settings → Pages → Build and deployment → Deploy from a branch → main / (root)** 선택.
3. 1~2분 뒤 `https://<아이디>.github.io/<저장소>/` 에서 열립니다.

```bash
git init && git add . && git commit -m "전북 면접사례 검색 앱 첫 배포"
git branch -M main
git remote add origin https://github.com/<아이디>/<저장소>.git
git push -u origin main
```

## 로컬에서 미리 보기

```bash
python -m http.server 8000   # 이 폴더에서 실행 후 http://localhost:8000
```
(`index.html`을 더블클릭하면 브라우저 보안 정책 때문에 데이터가 열리지 않습니다.)

## 사용법

- 검색창: 대학·학과·전형·질문·답변·기타정보를 한 번에 찾습니다. 띄어쓴 여러 단어는 모두 포함된 결과만 보여줍니다. (예: `전북대 미분`)
- 사례 / 질문 보기: "질문"을 누르면 질문 단위로 모아 봅니다(모의면접 질문 모으기).
- 카드 → 오른쪽에 면접 내용과 원본 PDF. 휴대폰에서는 전체 화면으로 열립니다.
- 단축키: `/` 검색, `←` `→` 이전/다음 결과, `Esc` 닫기.
- ★ 즐겨찾기와 "이 기기에서 기억하기"는 그 브라우저에만 저장됩니다.

자료 출처: 전북특별자치도교육청 대입 면접사례모음집 · 교내 진학 상담용 · 외부 공유 금지
