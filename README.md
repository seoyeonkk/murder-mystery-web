# 검은 유리 온실의 밤

60분 러닝타임의 온라인 머더미스터리 웹 프로토타입입니다. 의존성 없이 Node 기본 모듈만 사용합니다.

## 실행

```bash
npm run dev
```

브라우저에서 `http://localhost:5173`을 열고 방을 만든 뒤, 다른 브라우저나 기기에서 방 코드로 참가합니다.

혼자 기능 테스트를 할 때는 최소 인원을 1명으로 낮춰 실행합니다.

```bash
npm run dev:solo
```

## 배포 메모

이 앱은 방 상태, 채팅, 타이머, Server-Sent Events 연결을 Node 서버 메모리에 저장합니다. 그래서 현재 형태 그대로는 정적 호스팅에 올릴 수 없습니다.

- GitHub Pages: 정적 HTML/CSS/JS 호스팅만 가능하므로 현재 멀티플레이 서버는 동작하지 않습니다.
- Vercel: API/Function 배포는 가능하지만 서버 메모리에 방 상태를 두면 요청마다 상태가 유지된다고 보장할 수 없습니다.
- 프로덕션 권장안: Vercel 또는 GitHub Pages에는 프론트엔드를 올리고, 방 상태는 Supabase/Firebase/Redis 같은 외부 저장소에 둡니다.
- 가장 쉬운 현재 코드 배포안: Render, Fly.io, Railway 같은 장기 실행 Node 서버 호스팅에 올립니다.

## 공유용 배포

현재 코드를 가장 빨리 공유하려면 Render, Railway, Fly.io처럼 Node 서버를 계속 실행해 주는 호스팅을 사용합니다. 이 저장소에는 `render.yaml`과 `Dockerfile`이 포함되어 있습니다.

### Render

1. 이 폴더를 GitHub 저장소로 push합니다.
2. Render에서 New Web Service를 만들고 저장소를 연결합니다.
3. 설정값은 아래처럼 둡니다.
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Health Check Path: `/healthz`
   - Environment Variable: `MIN_PLAYERS=4`
4. 배포가 끝나면 Render가 주는 `https://...onrender.com` 주소를 참가자에게 공유합니다.

### Railway

1. GitHub 저장소를 Railway 프로젝트로 연결합니다.
2. Start Command가 필요하면 `npm start`로 설정합니다.
3. Environment Variable에 `MIN_PLAYERS=4`를 추가합니다.
4. 생성된 public domain을 참가자에게 공유합니다.

### Docker 호스팅

```bash
docker build -t murder-mystery-web .
docker run -p 5173:5173 -e MIN_PLAYERS=4 murder-mystery-web
```

운영 중 서버가 재시작되면 현재 방은 사라집니다. 장기적으로는 Redis/Supabase/Firebase 같은 외부 저장소를 붙이면 재시작에도 방을 유지할 수 있습니다.

## 포함 기능

- 4-8명 방 생성/참가
- 60분 진행표와 자동 단계 전환
- 호스트 시작, 다음 단계, 타이머 정지/재개
- 플레이어별 비밀 역할 카드
- 플레이어별 관계, 개인 미션, 압박 질문
- 공개 타임라인과 단계별 진행 질문
- 단계별 공개 단서
- 공용 채팅 기록
- 최종 투표와 진상 공개

현재 상태는 서버 메모리에만 저장됩니다. 서버를 재시작하면 방도 초기화됩니다.
