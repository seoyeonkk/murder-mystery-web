import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || "0.0.0.0";
const MIN_PLAYERS_OVERRIDE = process.env.MIN_PLAYERS
  ? Math.max(1, Number(process.env.MIN_PLAYERS))
  : null;

const rooms = new Map();
const streams = new Map();

const GREENHOUSE_PHASES = [
  {
    key: "briefing",
    label: "브리핑",
    minutes: 5,
    instruction:
      "각자 역할 카드를 읽고 공개 가능한 자기소개를 한다. 개인 비밀은 아직 숨긴다.",
    prompts: [
      "피해자와 마지막으로 대화한 시간을 공개한다.",
      "오늘 밤 온실에 온 공식적인 이유만 말한다.",
      "숨기고 싶은 행동은 직접 부정하지 말고 애매하게 돌려 말해도 된다.",
    ],
  },
  {
    key: "act1",
    label: "1막 공개 심문",
    minutes: 12,
    instruction:
      "사건 당시 동선, 관계, 금전 문제를 중심으로 질문한다. 거짓말은 가능하지만 역할 카드의 사실을 정면으로 부정하면 안 된다.",
    prompts: [
      "23:10-23:50 사이의 동선을 시간순으로 맞춘다.",
      "피해자에게 협박받았거나 돈을 요구받은 사람이 있는지 묻는다.",
      "CCTV 공백, 와인 트레이, 시약 열쇠 중 하나를 집중 심문한다.",
    ],
  },
  {
    key: "clue1",
    label: "단서 공개 1",
    minutes: 5,
    instruction:
      "새 공개 단서를 확인하고, 각자에게 유리한 해석과 불리한 해석을 모두 따져본다.",
    prompts: [
      "새 단서가 가리키는 용의자를 한 명씩 말한다.",
      "단서가 조작되었을 가능성이 있는지 검토한다.",
      "각자 지금까지 숨긴 작은 거짓말 하나를 공개할지 결정한다.",
    ],
  },
  {
    key: "act2",
    label: "2막 비밀 거래",
    minutes: 15,
    instruction:
      "숨긴 정보 일부를 거래하거나 폭로한다. 최종 투표 전에 가장 위험한 모순을 찾아낸다.",
    prompts: [
      "둘씩 짧게 비공개 협상하듯 정보를 교환한다. 웹에서는 채팅에 '귓속말처럼' 요약해 남긴다.",
      "자기 개인 단서를 공개하면 무엇을 얻을 수 있는지 계산한다.",
      "가장 모순이 큰 알리바이 2개를 전체 앞에서 검증한다.",
    ],
  },
  {
    key: "clue2",
    label: "단서 공개 2",
    minutes: 5,
    instruction:
      "마지막 물증이 공개된다. 시간표, 물건의 주인, 거짓 알리바이를 다시 맞춰본다.",
    prompts: [
      "녹음기, 안료, 장부를 서로 연결해 범행 경로를 만든다.",
      "범인이 아닌데도 거짓말한 사람들의 이유를 분리한다.",
      "최종 진술에서 말할 핵심 근거 2개를 고른다.",
    ],
  },
  {
    key: "final",
    label: "최종 진술/투표",
    minutes: 13,
    instruction:
      "각자 1분 안팎으로 최종 진술을 하고 범인을 지목한다. 투표 사유를 짧게 남긴다.",
    prompts: [
      "동기, 수단, 기회가 모두 맞는 사람만 지목한다.",
      "내가 숨긴 비밀이 사건의 핵심이 아니라는 점을 설명한다.",
      "투표 전 마지막 반박은 한 번만 허용한다.",
    ],
  },
  {
    key: "reveal",
    label: "진상 공개",
    minutes: 5,
    instruction:
      "투표 결과와 실제 진상을 확인한다. 범인은 자신의 승리 조건 달성 여부를 확인한다.",
    prompts: [
      "누가 어떤 단서 때문에 속았는지 짧게 복기한다.",
      "범인은 어느 순간 위험했는지 밝힌다.",
      "다음 플레이를 위해 단서 공개 속도와 난이도를 기록한다.",
    ],
  },
];

const GREENHOUSE_SCENARIO = {
  title: "검은 유리 온실의 밤",
  place: "해무가 짙은 사설 미술관, 유리 온실 별관",
  premise:
    "자정 직전, 미술관 후원자 윤태오가 온실 중앙의 검은 유리 테이블 위에서 숨진 채 발견됐다. 폭풍으로 다리가 끊겨 외부인은 들어올 수 없고, 현장에 있던 사람은 초대받은 손님뿐이다.",
  rules: [
    "역할 카드에 적힌 사실은 진실이다. 해석과 감정은 속여도 된다.",
    "개인 단서는 언제 공개해도 되지만, 공개 후에는 되돌릴 수 없다.",
    "범인은 거짓 알리바이를 유지해도 되지만, 공개 단서의 존재 자체를 부정할 수 없다.",
    "최종 투표는 동기, 수단, 기회 세 가지를 모두 설명할 수 있는 사람에게 한다.",
  ],
  timeline: [
    { time: "22:55", event: "폭풍 경보로 미술관 출입 시스템이 수동 잠금으로 전환된다." },
    { time: "23:08", event: "윤태오가 백유리에게 '검은 유리 아래'라는 문자를 보낸다." },
    { time: "23:10", event: "정성우의 시약 보관함 열쇠가 사라진다." },
    { time: "23:15", event: "문아라가 와인 트레이 바꿔치기 장면을 목격한다." },
    { time: "23:20", event: "강도윤과 윤태오가 상속 지분 문제로 다툰다." },
    { time: "23:31", event: "온실 비상문이 내부에서 열린 기록이 남는다." },
    { time: "23:33", event: "온실 복도에서 문이 안쪽에서 잠기는 소리가 들린다." },
    { time: "23:47", event: "온실 비상문이 다시 내부에서 열린 기록이 남는다." },
    { time: "23:55", event: "검은 유리 테이블 위에서 윤태오의 시신이 발견된다." },
  ],
  victim: "윤태오",
  killerRoleId: "seo-jin",
  truth:
    "범인은 한서진이다. 윤태오가 한서진의 위작 거래 장부와 협박 녹음을 공개하려 하자, 한서진은 23:32에 숨겨진 계단으로 온실에 들어가 수면제가 섞인 와인을 건넸다. 윤태오가 의식을 잃자 희귀 식물용 독성 시약을 주입했고, 현장을 난투처럼 보이게 만들었다. 불에 탄 계약서는 동기를 숨기기 위한 위장이고, 결정적 단서는 녹음기와 온실 난간의 녹색 안료다.",
  roles: [
    {
      id: "seo-jin",
      name: "한서진",
      archetype: "미술 복원가",
      publicInfo:
        "윤태오의 전속 복원가. 오늘 밤 공개될 작품의 마지막 검수를 맡았다.",
      privateInfo:
        "윤태오는 당신이 3년 전부터 위작을 진품처럼 복원해 유통했다는 사실을 알고 있었다. 오늘 밤 발표 직후 모든 증거를 공개하겠다고 협박했다.",
      objective:
        "최종 투표에서 범인 지목을 피한다. 가능하면 강도윤 또는 차민재에게 의심을 돌린다.",
      personalClue:
        "당신의 소매 안쪽에는 온실 난간을 칠할 때 쓰인 녹색 안료가 묻어 있다. 질문받기 전까지 절대 먼저 말하지 않는다.",
      startLie:
        "23:25부터 23:45까지 보존실에서 작품 상태를 확인했다고 주장한다.",
      timelineClaim:
        "23:12 복원실, 23:25 보존실, 23:44 복원실. 온실에는 가지 않았다고 말한다.",
      relationships: [
        "오혜린은 계약서 예산을 보고 당신을 의심할 수 있다.",
        "이이안은 위작 라벨 때문에 당신의 개인 인장을 알고 있다.",
        "문아라는 붉은 실 팔찌를 봤지만 얼굴은 보지 못했다.",
      ],
      secretTasks: [
        "불탄 계약서가 공개되면 H.S.J.가 다른 약자일 수 있다고 주장한다.",
        "녹색 안료는 복원가라면 누구에게나 묻을 수 있다고 설명한다.",
        "차민재의 CCTV 조작을 크게 키워 수사 방향을 돌린다.",
      ],
      pressureQuestions: [
        "정성우에게 열쇠를 잃어버린 시간을 구체적으로 묻는다.",
        "강도윤에게 상속 다툼을 왜 숨겼는지 추궁한다.",
        "백유리에게 서재에 들어간 이유를 물어 취재 윤리를 공격한다.",
      ],
    },
    {
      id: "do-yoon",
      name: "강도윤",
      archetype: "상속 예정자",
      publicInfo:
        "윤태오의 조카. 최근 후원 재단의 지분 승계를 두고 피해자와 다퉜다.",
      privateInfo:
        "당신은 23:20에 윤태오와 크게 말다툼했다. 그러나 23:33에는 온실 밖 복도에서 문이 안쪽에서 잠기는 소리를 들었다.",
      objective:
        "상속 문제 때문에 의심받지 않게 하면서, 23:33의 잠금 소리를 적절한 타이밍에 공개한다.",
      personalClue:
        "윤태오의 손에 쥐어진 단추는 당신 재킷 것이 아니다. 당신 재킷 단추는 모두 붙어 있다.",
      startLie:
        "다툼은 없었고 짧은 인사만 했다고 말하고 싶다.",
      timelineClaim:
        "23:18 온실 앞 복도, 23:20 피해자와 언쟁, 23:33 문 잠금 소리 목격, 23:40 라운지.",
      relationships: [
        "차민재에게 CCTV 공백을 부탁했고 돈을 건넸다.",
        "오혜린은 당신의 상속 서류를 검토한 적이 있다.",
        "윤태오는 당신을 재단에서 밀어내려 했다.",
      ],
      secretTasks: [
        "CCTV 조작 대가를 숨기면서도 23:33 잠금 소리는 반드시 공개한다.",
        "단추 단서를 이용해 자신이 몸싸움하지 않았음을 증명한다.",
        "최종 투표 전 상속 동기만으로는 수단이 없다는 점을 강조한다.",
      ],
      pressureQuestions: [
        "차민재에게 CCTV가 꺼진 정확한 위치를 묻는다.",
        "한서진에게 23:30대 보존실에 누가 있었는지 묻는다.",
        "이이안에게 피해자와 돈 문제로 다투지 않았는지 확인한다.",
      ],
    },
    {
      id: "yoo-ri",
      name: "백유리",
      archetype: "탐사 기자",
      publicInfo:
        "미술계 비리를 취재하는 기자. 피해자에게 단독 인터뷰를 약속받았다.",
      privateInfo:
        "당신은 윤태오에게서 '검은 유리 온실에 진짜 장부가 있다'는 문자를 받았다. 하지만 취재 윤리를 어기고 그의 서재를 몰래 뒤졌다.",
      objective:
        "장부의 위치를 찾아 진실을 밝힌다. 서재 침입 사실은 가능하면 숨긴다.",
      personalClue:
        "서재 쓰레기통에서 반쯤 탄 계약서 조각을 챙겼다. 서명란에는 'H.S.J.'가 보인다.",
      startLie:
        "오늘 밤에는 취재가 아니라 초대 손님 자격으로 왔다고 말한다.",
      timelineClaim:
        "23:08 문자 수신, 23:16 서재 근처, 23:28 라운지, 23:46 온실 복도 도착.",
      relationships: [
        "오혜린은 당신이 재단 비리를 캐고 있다는 사실을 알고 있다.",
        "한서진은 당신의 취재 대상이지만 아직 직접 증거는 부족하다.",
        "차민재는 당신이 서재로 들어가는 것을 봤을 수 있다.",
      ],
      secretTasks: [
        "서재 침입은 늦게 공개하되, 계약서 조각은 결정적 순간에 사용한다.",
        "문자 단서와 장부 위치를 연결해 피해자의 의도를 설명한다.",
        "범인을 맞히지 못해도 위작 거래의 증거를 확보하면 부분 승리다.",
      ],
      pressureQuestions: [
        "오혜린에게 새 계약서의 실제 담당자를 묻는다.",
        "한서진에게 H.S.J. 이니셜의 다른 후보를 말해보라고 요구한다.",
        "문아라에게 와인 트레이를 본 각도와 손목 장식을 자세히 묻는다.",
      ],
    },
    {
      id: "min-jae",
      name: "차민재",
      archetype: "보안 책임자",
      publicInfo:
        "미술관 보안 책임자. 폭풍 때문에 모든 출입문을 수동 잠금으로 전환했다.",
      privateInfo:
        "22:55에 CCTV 일부를 껐다. 이유는 강도윤에게 돈을 받고 그의 비밀 만남을 숨겨주기 위해서였다.",
      objective:
        "CCTV 조작은 숨기되, 온실 비상문 로그가 조작되지 않았다는 점을 증명한다.",
      personalClue:
        "비상문 로그에는 23:31, 23:47 두 번의 내부 개방 기록이 있다. 외부 개방 기록은 없다.",
      startLie:
        "CCTV는 폭풍으로 자동 고장 났다고 설명한다.",
      timelineClaim:
        "22:55 출입 수동 전환, 23:02 CCTV 점검, 23:31 비상문 로그 확인, 23:50 현장 출동.",
      relationships: [
        "강도윤의 부탁으로 일부 카메라를 껐다.",
        "백유리가 서재 쪽 복도에 있던 것을 봤지만 확신은 없다.",
        "정성우의 시약실 출입 로그를 당신만 확인할 수 있다.",
      ],
      secretTasks: [
        "CCTV 조작을 인정해야 한다면 강도윤의 부탁 때문이었다고 제한적으로 공개한다.",
        "비상문이 외부에서 열리지 않았다는 점을 계속 밀어붙인다.",
        "범인이 내부 경로나 숨겨진 계단을 썼다는 가설을 세운다.",
      ],
      pressureQuestions: [
        "강도윤에게 돈을 준 이유를 공개할지 압박한다.",
        "정성우에게 열쇠 분실 신고를 왜 안 했는지 묻는다.",
        "백유리에게 서재 근처에 있던 이유를 확인한다.",
      ],
    },
    {
      id: "hye-rin",
      name: "오혜린",
      archetype: "재단 변호사",
      publicInfo:
        "윤태오 재단의 법률 대리인. 오늘 새 후원 계약서를 검토했다.",
      privateInfo:
        "피해자는 당신에게 재단 돈세탁 정황을 덮어달라고 요구했다. 당신은 거절했고, 녹음 파일을 넘기겠다는 말을 들었다.",
      objective:
        "피해자가 여러 사람을 협박했다는 사실을 드러내되, 당신의 고객 비밀 누설은 피한다.",
      personalClue:
        "새 계약서 원본에는 위작 복원 프로젝트 예산이 비정상적으로 크다. 담당자는 한서진이다.",
      startLie:
        "계약서는 평범한 후원 계약이었다고 말한다.",
      timelineClaim:
        "23:05 피해자와 계약서 검토, 23:22 통화 기록 확인, 23:35 라운지에서 대기.",
      relationships: [
        "윤태오는 재단 돈세탁을 덮으라고 압박했다.",
        "한서진의 복원 프로젝트 예산이 비정상적으로 큰 것을 알고 있다.",
        "강도윤의 상속 서류가 오늘 밤 수정될 예정이었다.",
      ],
      secretTasks: [
        "변호사 비밀 유지 때문에 처음부터 모든 계약 내용을 공개하지 않는다.",
        "돈세탁 문제와 살인은 별개라는 점을 분리한다.",
        "한서진의 예산 라인을 공개할 타이밍을 고른다.",
      ],
      pressureQuestions: [
        "한서진에게 복원 프로젝트 예산 사용처를 묻는다.",
        "강도윤에게 상속 변경 사실을 알고 있었는지 묻는다.",
        "이이안에게 피해자가 환불을 거절한 정확한 이유를 요구한다.",
      ],
    },
    {
      id: "ian",
      name: "이이안",
      archetype: "해외 컬렉터",
      publicInfo:
        "경매장에서 윤태오와 자주 경쟁한 컬렉터. 오늘 밤 비공개 구매 제안을 했다.",
      privateInfo:
        "당신은 윤태오에게 위작을 산 적이 있다. 오늘 환불과 사과를 요구했고, 거절당했다.",
      objective:
        "위작 구매 사실을 감추면서, 누가 위작을 만들었는지 밝혀 손해를 회수할 명분을 얻는다.",
      personalClue:
        "당신이 산 그림 뒷면의 복원 라벨은 한서진의 개인 인장과 일치한다.",
      startLie:
        "윤태오와는 좋은 거래 관계였다고 말한다.",
      timelineClaim:
        "23:11 피해자에게 환불 요구, 23:26 통화 시도, 23:39 온실 근처에서 발길을 돌림.",
      relationships: [
        "한서진의 인장을 알고 있지만 공개하면 자신도 위작 구매 사실을 인정해야 한다.",
        "백유리는 당신에게 취재 협조를 요구한 적이 있다.",
        "문아라가 준비한 와인을 피해자와 함께 마시기로 되어 있었다.",
      ],
      secretTasks: [
        "위작 구매 사실을 들키지 않게 하면서 인장 정보를 흘린다.",
        "피해자에게 환불을 요구한 통화 기록이 공개되기 전에 해명한다.",
        "최종적으로 위작 제작자를 특정하면 부분 승리다.",
      ],
      pressureQuestions: [
        "한서진에게 개인 인장이 어디까지 쓰이는지 묻는다.",
        "백유리에게 장부를 왜 혼자 찾으려 했는지 묻는다.",
        "문아라에게 피해자에게 간 와인잔이 몇 개인지 확인한다.",
      ],
    },
    {
      id: "ara",
      name: "문아라",
      archetype: "케이터링 셰프",
      publicInfo:
        "행사 케이터링을 맡은 셰프. 와인과 디저트가 온실로 옮겨지는 것을 관리했다.",
      privateInfo:
        "23:15에 누군가 와인 트레이를 바꿔치기하는 장면을 봤지만 얼굴은 보지 못했다. 대신 손목의 붉은 실 팔찌를 봤다.",
      objective:
        "음식 탓으로 몰리지 않는다. 붉은 실 팔찌의 주인을 찾아낸다.",
      personalClue:
        "한서진은 작품 손상을 막는다는 이유로 늘 붉은 실 팔찌를 착용한다.",
      startLie:
        "와인 트레이는 처음부터 끝까지 직접 관리했다고 말한다.",
      timelineClaim:
        "23:15 트레이 바꿔치기 목격, 23:21 주방 복귀, 23:36 디저트 준비, 23:52 현장 도착.",
      relationships: [
        "이이안이 피해자와 같은 와인을 마시려 했다는 것을 알고 있다.",
        "한서진의 붉은 실 팔찌를 여러 번 본 적이 있다.",
        "정성우가 시약 냄새에 민감하다는 말을 들었다.",
      ],
      secretTasks: [
        "음식이나 와인 관리 책임으로 몰리지 않게 목격 정보를 단계적으로 공개한다.",
        "팔찌 단서를 공개하기 전 누가 손목 장식을 했는지 자연스럽게 물어본다.",
        "와인잔에 독이 아니라 수면제가 있었다는 사실이 나오면 적극 방어한다.",
      ],
      pressureQuestions: [
        "한서진에게 오늘 팔찌를 찼는지 직접 묻는다.",
        "이이안에게 와인을 바꿔 마신 적이 있는지 확인한다.",
        "차민재에게 주방 복도 CCTV가 왜 비었는지 묻는다.",
      ],
    },
    {
      id: "sung-woo",
      name: "정성우",
      archetype: "식물학자",
      publicInfo:
        "온실 희귀 식물 관리 자문. 독성 시약과 보존 용액을 관리한다.",
      privateInfo:
        "당신의 시약 보관함 열쇠가 23:10부터 23:50까지 사라졌다. 되찾았을 때 독성 시약 한 병이 비어 있었다.",
      objective:
        "시약 관리 책임을 피하면서, 열쇠를 가져간 사람을 찾는다.",
      personalClue:
        "열쇠고리에는 녹색 안료가 얇게 묻어 있었다.",
      startLie:
        "시약 보관함은 밤새 잠겨 있었다고 말한다.",
      timelineClaim:
        "23:10 열쇠 분실 인지, 23:24 온실 습도 점검, 23:50 열쇠 회수, 23:55 시신 발견.",
      relationships: [
        "한서진은 복원실 안료와 온실 보존제를 모두 다룰 수 있다.",
        "문아라는 독성 시약 냄새를 구분하지 못한다.",
        "차민재는 시약실 출입 로그를 확인할 권한이 있다.",
      ],
      secretTasks: [
        "열쇠 분실을 너무 늦게 말하면 의심받는다. 단서 공개 1 이후에는 해명한다.",
        "독성 시약이 와인이 아니라 주입 흔적에서 나왔다는 점을 강조한다.",
        "녹색 안료가 열쇠고리에 묻은 경로를 추적한다.",
      ],
      pressureQuestions: [
        "한서진에게 복원실 안료가 왜 시약실 열쇠에 묻는지 묻는다.",
        "차민재에게 시약실 로그 원본을 공개하라고 요구한다.",
        "오혜린에게 시약 관리 책임을 법적으로 누구에게 묻는지 확인한다.",
      ],
    },
  ],
  clues: [
    {
      id: "scene",
      unlockPhase: "briefing",
      title: "현장 상태",
      body:
        "윤태오는 23:30-23:45 사이 사망한 것으로 보인다. 온실 정문은 안쪽에서 잠겨 있었고, 검은 유리 테이블 아래에는 깨진 와인잔이 있다.",
    },
    {
      id: "message",
      unlockPhase: "briefing",
      title: "마지막 문자",
      body:
        "피해자는 23:08에 '오늘 밤 진짜 장부를 공개한다. 검은 유리 아래.'라는 문자를 백유리에게 보냈다.",
    },
    {
      id: "button",
      unlockPhase: "briefing",
      title: "피해자의 손 안",
      body:
        "윤태오의 오른손에는 짙은 남색 단추 하나가 쥐어져 있다. 단추에는 오래된 향수 냄새와 아주 희미한 왁스가 묻어 있다.",
    },
    {
      id: "mud",
      unlockPhase: "briefing",
      title: "젖은 흙 발자국",
      body:
        "온실 숨은 계단 아래에서 젖은 흙 발자국이 발견됐다. 발자국은 구두보다 작업화에 가깝지만, 크기는 명확하지 않다.",
    },
    {
      id: "contract",
      unlockPhase: "clue1",
      title: "불탄 계약서 조각",
      body:
        "난로에서 발견된 계약서 조각에는 대형 복원 예산과 서명 이니셜 'H.S.J.'가 남아 있다.",
    },
    {
      id: "inheritance",
      unlockPhase: "clue1",
      title: "상속 변경 초안",
      body:
        "오혜린의 서류 가방에서 윤태오 재단 지분을 강도윤에게서 회수하는 초안이 발견된다. 아직 서명은 없다.",
    },
    {
      id: "door-log",
      unlockPhase: "clue1",
      title: "비상문 로그",
      body:
        "온실 비상문은 23:31과 23:47에 내부에서 열린 기록만 있다. 외부에서 열린 기록은 없다.",
    },
    {
      id: "camera-gap",
      unlockPhase: "clue1",
      title: "CCTV 공백",
      body:
        "22:55-23:48 사이 보존실 복도와 주방 복도 영상만 비어 있다. 폭풍으로 전체 시스템이 꺼진 것은 아니다.",
    },
    {
      id: "wine",
      unlockPhase: "clue1",
      title: "와인잔 분석",
      body:
        "깨진 와인잔에서는 강한 수면제 흔적이 검출됐다. 독성 시약은 잔이 아니라 피해자의 손목 근처에서 검출됐다.",
    },
    {
      id: "key-cabinet",
      unlockPhase: "clue1",
      title: "시약 보관함",
      body:
        "독성 시약 한 병이 비어 있고, 보관함 내부에는 얇은 녹색 가루가 남아 있다. 강제로 열린 흔적은 없다.",
    },
    {
      id: "recorder",
      unlockPhase: "clue2",
      title: "숨겨진 녹음기",
      body:
        "검은 유리 테이블 아래 녹음기에는 '복원가가 만든 가짜들까지 오늘 끝내자'라는 윤태오의 목소리와, 뒤이어 낮은 여성 목소리가 남아 있다.",
    },
    {
      id: "bracelet-thread",
      unlockPhase: "clue2",
      title: "붉은 실 조각",
      body:
        "깨진 와인잔 받침 아래에 붉은 실 한 올이 끼어 있다. 케이터링 장갑 섬유와는 다르고, 장식 팔찌에 쓰이는 꼬임이다.",
    },
    {
      id: "paint",
      unlockPhase: "clue2",
      title: "난간의 녹색 안료",
      body:
        "숨겨진 계단 난간에서 특수 녹색 안료가 묻어 나왔다. 같은 안료는 복원실과 시약 보관함 열쇠고리에서도 발견된다.",
    },
    {
      id: "phone-call",
      unlockPhase: "clue2",
      title: "끊긴 국제전화",
      body:
        "23:26에 이이안이 윤태오에게 18초간 전화를 걸었다. 통화 내용은 남아 있지 않지만, 직후 윤태오가 '환불은 없다'고 메모했다.",
    },
    {
      id: "table",
      unlockPhase: "clue2",
      title: "검은 유리 아래",
      body:
        "테이블 아래 비밀 홈에는 위작 거래 장부가 있었다. 장부에는 한서진의 개인 인장과 윤태오의 지급 내역이 반복된다.",
    },
  ],
};

const CAFE_PHASES = [
  {
    key: "briefing",
    label: "사건 읽기",
    minutes: 3,
    instruction:
      "등장인물과 규칙을 읽고, 오늘 풀어야 할 질문을 확인한다. 이 게임은 1명도 진행할 수 있는 입문 추리다.",
    prompts: [
      "사라진 것은 무엇이고, 마지막으로 본 시간은 언제인지 확인한다.",
      "범인을 맞히기보다 '어디로 사라졌는지'를 먼저 생각한다.",
      "확실한 사실과 추측을 나눠 적는다.",
    ],
  },
  {
    key: "act1",
    label: "첫 조사",
    minutes: 7,
    instruction:
      "초대장이 붙어 있던 게시판 주변, 우산꽂이, 계산대, 창가 테이블을 차례로 살펴본다.",
    prompts: [
      "젖은 흔적이 어디에서 어디로 이어지는지 말한다.",
      "사람이 일부러 숨긴 행동인지, 우연히 옮겨진 흔적인지 구분한다.",
      "가장 수상한 후보를 1명 고르고 이유를 남긴다.",
    ],
  },
  {
    key: "clue1",
    label: "새 단서",
    minutes: 5,
    instruction:
      "새로 공개된 단서를 이전 흔적과 연결한다. 입문 게임이라 단서끼리 직접 이어지도록 설계되어 있다.",
    prompts: [
      "설탕물, 발자국, 리본 조각이 같은 방향을 가리키는지 본다.",
      "사람의 동기와 고양이의 행동 중 어느 쪽이 더 자연스러운지 비교한다.",
      "틀린 가설 하나를 버린다.",
    ],
  },
  {
    key: "final",
    label: "정답 고르기",
    minutes: 7,
    instruction:
      "누가 초대장을 가져갔는지, 그리고 초대장이 어디에 있는지 최종 답을 고른다.",
    prompts: [
      "후보를 고를 때는 동기보다 물리적 흔적을 우선한다.",
      "초대장이 젖지 않고 사라졌다는 점을 설명한다.",
      "투표 사유에는 결정적 단서 2개를 적는다.",
    ],
  },
  {
    key: "reveal",
    label: "해답 확인",
    minutes: 3,
    instruction:
      "정답과 해설을 확인한다. 어떤 단서가 가장 빨리 길을 열어줬는지 짧게 복기한다.",
    prompts: [
      "헷갈리게 만든 단서와 확신을 준 단서를 나눈다.",
      "다음 게임에서는 어떤 질문을 먼저 던질지 정한다.",
    ],
  },
];

const CAFE_SCENARIO = {
  title: "고양이 찻집의 사라진 초대장",
  place: "비 오는 저녁, 골목 끝 작은 찻집 '달빛다방'",
  premise:
    "동네 보드게임 모임 초대장이 찻집 게시판에서 사라졌다. 모임은 30분 뒤 시작되지만 초대장에는 참가 암호와 예약 좌석 번호가 적혀 있다. 가게 안에는 단골 손님 몇 명, 우산꽂이, 장난꾸러기 고양이 밤이뿐이다.",
  rules: [
    "이 게임은 1명도 혼자 읽고 추리할 수 있다.",
    "2명이 할 때는 각자 역할 카드의 개인 단서를 천천히 공개한다.",
    "거짓말보다 추론 연습이 중심이다. 헷갈리면 공개 타임라인부터 다시 본다.",
    "최종 답은 후보 중 하나를 고르고, 사유에 결정적 단서 2개를 적는다.",
  ],
  timeline: [
    { time: "18:10", event: "초대장이 계산대 옆 게시판에 붙는다." },
    { time: "18:18", event: "민우가 우산을 접어 우산꽂이에 넣는다." },
    { time: "18:22", event: "고양이 밤이가 창가 테이블 아래로 뛰어간다." },
    { time: "18:25", event: "소라가 게시판 앞에서 사진을 찍는다." },
    { time: "18:31", event: "점장 태준이 설탕 시럽을 닦다가 잠시 계산대를 비운다." },
    { time: "18:36", event: "초대장이 게시판에서 사라진 것이 발견된다." },
  ],
  victim: "사라진 초대장",
  killerRoleId: null,
  solutionChoices: [
    { id: "cat-bami", name: "밤이", archetype: "찻집 고양이" },
    { id: "minu", name: "민우", archetype: "젖은 우산을 든 손님" },
    { id: "sora", name: "소라", archetype: "사진을 찍은 단골" },
    { id: "taejun", name: "태준", archetype: "찻집 점장" },
  ],
  truth:
    "정답은 고양이 밤이다. 밤이가 게시판 아래 장식 리본을 물고 놀다가 초대장 핀을 건드렸고, 떨어진 초대장은 젖은 우산 손잡이에 붙었다. 민우가 우산을 우산꽂이에 넣으면서 초대장이 함께 끌려가 우산꽂이 뒤쪽에 끼었다. 소라는 사진을 찍었을 뿐이고, 태준은 설탕 시럽을 닦느라 게시판을 보지 못했다. 결정적 단서는 젖은 발자국, 리본 실 조각, 우산꽂이 뒤의 마른 종이 모서리다.",
  roles: [
    {
      id: "rookie-detective",
      name: "윤하늘",
      archetype: "초보 탐정",
      publicInfo:
        "동네 보드게임 모임에 처음 온 참가자. 추리 게임은 익숙하지 않지만 관찰력이 좋다.",
      privateInfo:
        "18:22에 밤이가 창가 테이블 아래로 뛰어가며 빨간 리본을 물고 있는 것을 봤다. 그때는 장난감인 줄 알았다.",
      objective:
        "초대장을 가져간 후보와 초대장의 위치를 맞힌다. 사람을 너무 빨리 의심하지 않는다.",
      personalClue:
        "게시판 아래 바닥에 젖은 발자국 3개가 있다. 사람 발자국이 아니라 작은 동물 발자국처럼 보인다.",
      startLie:
        "처음에는 민우의 젖은 우산이 가장 수상하다고 말해도 된다.",
      timelineClaim:
        "18:18 우산꽂이 근처, 18:22 창가 테이블, 18:36 게시판 앞.",
      relationships: [
        "민우는 우산을 급하게 접느라 주변을 잘 보지 못했다.",
        "소라는 게시판 사진을 가지고 있을 수 있다.",
        "밤이는 빨간 리본이나 끈을 보면 달려드는 습관이 있다.",
      ],
      secretTasks: [
        "첫 조사 단계에서는 발자국 단서를 공개한다.",
        "새 단서 단계에서는 리본과 발자국을 연결한다.",
        "최종 답에는 초대장의 위치도 함께 설명한다.",
      ],
      pressureQuestions: [
        "민우에게 우산을 넣을 때 종이가 붙어 있었는지 묻는다.",
        "소라에게 사진 속 게시판 아래가 보이는지 묻는다.",
        "태준에게 밤이가 리본을 좋아하는지 확인한다.",
      ],
    },
    {
      id: "note-keeper",
      name: "서지우",
      archetype: "기록 담당",
      publicInfo:
        "모임 참가자 명단을 정리하러 온 기록 담당. 작은 시간 차이를 잘 기억한다.",
      privateInfo:
        "소라가 찍은 사진을 잠깐 봤다. 사진 속 초대장은 아직 게시판에 있고, 아래쪽 핀이 살짝 들려 있다.",
      objective:
        "사진, 우산꽂이, 리본 실을 연결해 초대장이 실수로 옮겨졌다는 결론을 돕는다.",
      personalClue:
        "우산꽂이 뒤쪽에 마른 종이 모서리 같은 것이 보인다. 손을 뻗어 꺼내야 확인할 수 있다.",
      startLie:
        "처음에는 사진을 찍은 소라가 초대장을 가져갔을지도 모른다고 의심한다.",
      timelineClaim:
        "18:25 게시판 사진 확인, 18:31 계산대 앞, 18:36 우산꽂이 근처.",
      relationships: [
        "하늘은 발자국을 봤지만 사진 단서는 모른다.",
        "소라는 초대장을 훔칠 이유가 약하다.",
        "태준은 밤이가 장식 리본을 자주 물어뜯는다고 알고 있다.",
      ],
      secretTasks: [
        "소라를 너무 오래 몰아붙이지 말고 사진 단서를 확인한다.",
        "우산꽂이 뒤쪽을 조사해야 한다는 제안을 한다.",
        "최종 답에는 '고의 절도 아님'을 분명히 적는다.",
      ],
      pressureQuestions: [
        "하늘에게 발자국 모양을 자세히 설명해달라고 한다.",
        "민우에게 우산 손잡이가 젖어 있었는지 묻는다.",
        "태준에게 밤이가 최근에도 종이나 리본을 물고 간 적 있는지 묻는다.",
      ],
    },
  ],
  clues: [
    {
      id: "notice-board",
      unlockPhase: "briefing",
      title: "빈 게시판",
      body:
        "초대장이 있던 자리에는 핀 하나만 비스듬히 꽂혀 있다. 종이가 찢긴 흔적은 없고, 누군가 조심스럽게 떼어낸 것 같지도 않다.",
    },
    {
      id: "photo",
      unlockPhase: "briefing",
      title: "소라의 사진",
      body:
        "18:25 사진에는 초대장이 아직 게시판에 붙어 있다. 아래쪽 핀이 살짝 들려 있고, 게시판 아래에는 빨간 리본 장식이 보인다.",
    },
    {
      id: "pawprints",
      unlockPhase: "act1",
      title: "작은 젖은 발자국",
      body:
        "게시판 아래에서 창가 테이블 쪽으로 작은 발자국이 이어진다. 발자국은 사람 신발이 아니라 고양이 발 모양에 가깝다.",
    },
    {
      id: "umbrella",
      unlockPhase: "act1",
      title: "우산꽂이",
      body:
        "우산꽂이 바닥은 젖어 있지만 뒤쪽 벽면은 마른 상태다. 뒤쪽 틈에 종이 모서리처럼 보이는 밝은 색이 있다.",
    },
    {
      id: "red-thread",
      unlockPhase: "clue1",
      title: "빨간 실 한 올",
      body:
        "게시판 핀 아래에 빨간 리본 실 한 올이 끼어 있다. 밤이가 좋아하는 창가 장난감 리본과 같은 색이다.",
    },
    {
      id: "syrup",
      unlockPhase: "clue1",
      title: "설탕 시럽 자국",
      body:
        "계산대에는 태준이 닦던 설탕 시럽 자국이 남아 있다. 시럽은 게시판 쪽이 아니라 계산대 안쪽에만 묻어 있다.",
    },
    {
      id: "corner",
      unlockPhase: "final",
      title: "마른 종이 모서리",
      body:
        "우산꽂이 뒤쪽에서 마른 종이 모서리가 보인다. 젖은 우산에 붙었다가 뒤로 밀려 들어간 것처럼 구겨져 있다.",
    },
  ],
};

const GAMES = {
  greenhouse: {
    id: "greenhouse",
    title: GREENHOUSE_SCENARIO.title,
    tagline: "60분 정통 머더미스터리",
    description:
      "4-8명이 각자 비밀을 가진 용의자가 되어 대화와 단서로 범인을 찾아내는 본격 추리극.",
    difficulty: "보통",
    coverImage: "/assets/greenhouse.svg",
    minPlayers: 4,
    maxPlayers: 8,
    phases: GREENHOUSE_PHASES,
    scenario: GREENHOUSE_SCENARIO,
  },
  cafe: {
    id: "cafe",
    title: CAFE_SCENARIO.title,
    tagline: "25분 입문 추리",
    description:
      "1명은 혼자 읽고 풀고, 2명은 단서를 나눠 읽으며 연습할 수 있는 가벼운 미스터리.",
    difficulty: "쉬움",
    coverImage: "/assets/teahouse.svg",
    minPlayers: 1,
    maxPlayers: 2,
    phases: CAFE_PHASES,
    scenario: CAFE_SCENARIO,
  },
};

const DEFAULT_GAME_ID = "greenhouse";

function gameConfig(gameId) {
  return GAMES[gameId] || GAMES[DEFAULT_GAME_ID];
}

function gameConfigForRoom(room) {
  return gameConfig(room.gameId);
}

function minPlayersForGame(game) {
  if (!MIN_PLAYERS_OVERRIDE) return game.minPlayers;
  return Math.min(game.minPlayers, game.maxPlayers, MIN_PLAYERS_OVERRIDE);
}

function gameCatalog() {
  return Object.values(GAMES).map((game) => ({
    id: game.id,
    title: game.title,
    tagline: game.tagline,
    description: game.description,
    difficulty: game.difficulty,
    coverImage: game.coverImage,
    minPlayers: minPlayersForGame(game),
    maxPlayers: game.maxPlayers,
    totalRuntimeMinutes: game.phases.reduce((sum, phase) => sum + phase.minutes, 0),
  }));
}

function phaseIndexMap(phases) {
  return Object.fromEntries(phases.map((phase, index) => [phase.key, index]));
}

function now() {
  return Date.now();
}

function id(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

function roomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return rooms.has(code) ? roomCode() : code;
}

function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function selectedRoles(game, playerCount) {
  const { scenario } = game;
  if (playerCount > scenario.roles.length) {
    throw httpError(400, "이 게임의 역할 수보다 참가자가 많습니다.");
  }
  if (!scenario.killerRoleId) {
    return shuffle(scenario.roles).slice(0, playerCount);
  }
  const killer = scenario.roles.find((role) => role.id === scenario.killerRoleId);
  const others = scenario.roles.filter((role) => role.id !== scenario.killerRoleId);
  return shuffle([killer, ...shuffle(others).slice(0, Math.max(0, playerCount - 1))]);
}

function createRoom(hostName, gameId) {
  const game = gameConfig(gameId);
  const code = roomCode();
  const hostId = id("player");
  const room = {
    code,
    gameId: game.id,
    status: "lobby",
    hostId,
    players: [
      {
        id: hostId,
        name: cleanName(hostName),
        connected: true,
        joinedAt: now(),
        roleId: null,
        vote: null,
      },
    ],
    phaseIndex: 0,
    phaseStartedAt: null,
    phaseEndsAt: null,
    paused: false,
    pauseRemainingMs: null,
    messages: [
      {
        id: id("msg"),
        type: "system",
        at: now(),
        author: "시스템",
        text: `방이 만들어졌다. ${minPlayersForGame(game)}-${game.maxPlayers}명이 모이면 호스트가 게임을 시작할 수 있다.`,
      },
    ],
    createdAt: now(),
  };
  rooms.set(code, room);
  return { room, playerId: hostId };
}

function cleanName(value) {
  const name = String(value || "").trim().replace(/\s+/g, " ");
  return name.slice(0, 18) || "익명";
}

function findRoom(code) {
  const room = rooms.get(String(code || "").trim().toUpperCase());
  if (!room) throw httpError(404, "방을 찾을 수 없습니다.");
  return room;
}

function findPlayer(room, playerId) {
  return room.players.find((player) => player.id === playerId);
}

function assertPlayer(room, playerId) {
  const player = findPlayer(room, playerId);
  if (!player) throw httpError(403, "플레이어 정보를 확인할 수 없습니다.");
  return player;
}

function assertHost(room, playerId) {
  const player = assertPlayer(room, playerId);
  if (room.hostId !== player.id) throw httpError(403, "호스트만 실행할 수 있습니다.");
  return player;
}

function startRoom(room, playerId) {
  assertHost(room, playerId);
  const game = gameConfigForRoom(room);
  if (room.status !== "lobby") throw httpError(409, "이미 시작된 방입니다.");
  const minPlayers = minPlayersForGame(game);
  if (room.players.length < minPlayers) {
    throw httpError(400, `최소 ${minPlayers}명이 필요합니다.`);
  }
  if (room.players.length > game.maxPlayers) {
    throw httpError(400, `최대 ${game.maxPlayers}명까지 가능합니다.`);
  }

  const roles = selectedRoles(game, room.players.length);
  shuffle(room.players).forEach((player, index) => {
    player.roleId = roles[index].id;
    player.vote = null;
  });

  room.status = "playing";
  room.phaseIndex = 0;
  room.phaseStartedAt = now();
  room.phaseEndsAt = room.phaseStartedAt + game.phases[0].minutes * 60 * 1000;
  room.messages.push({
    id: id("msg"),
    type: "system",
    at: now(),
    author: "시스템",
    text: "게임이 시작됐다. 역할 카드를 읽고 첫 단계를 진행한다.",
  });
}

function advanceRoom(room, playerId) {
  assertHost(room, playerId);
  const game = gameConfigForRoom(room);
  if (room.status !== "playing") throw httpError(409, "진행 중인 게임이 아닙니다.");
  if (room.phaseIndex >= game.phases.length - 1) {
    room.status = "finished";
    room.messages.push({
      id: id("msg"),
      type: "system",
      at: now(),
      author: "시스템",
      text: "게임이 종료됐다.",
    });
    return;
  }
  room.phaseIndex += 1;
  room.phaseStartedAt = now();
  room.phaseEndsAt = room.phaseStartedAt + game.phases[room.phaseIndex].minutes * 60 * 1000;
  room.paused = false;
  room.pauseRemainingMs = null;
  room.messages.push({
    id: id("msg"),
    type: "system",
    at: now(),
    author: "시스템",
    text: `${game.phases[room.phaseIndex].label} 단계로 넘어갔다.`,
  });
}

function togglePause(room, playerId) {
  assertHost(room, playerId);
  if (room.status !== "playing") throw httpError(409, "진행 중인 게임이 아닙니다.");
  if (room.paused) {
    room.phaseEndsAt = now() + room.pauseRemainingMs;
    room.pauseRemainingMs = null;
    room.paused = false;
    room.messages.push({
      id: id("msg"),
      type: "system",
      at: now(),
      author: "시스템",
      text: "타이머가 재개됐다.",
    });
  } else {
    room.pauseRemainingMs = Math.max(0, room.phaseEndsAt - now());
    room.paused = true;
    room.messages.push({
      id: id("msg"),
      type: "system",
      at: now(),
      author: "시스템",
      text: "타이머가 일시정지됐다.",
    });
  }
}

function autoAdvance(room) {
  if (room.status !== "playing" || room.paused || !room.phaseEndsAt) return false;
  const game = gameConfigForRoom(room);
  let changed = false;
  while (room.phaseIndex < game.phases.length - 1 && now() >= room.phaseEndsAt) {
    room.phaseIndex += 1;
    room.phaseStartedAt = now();
    room.phaseEndsAt = room.phaseStartedAt + game.phases[room.phaseIndex].minutes * 60 * 1000;
    room.messages.push({
      id: id("msg"),
      type: "system",
      at: now(),
      author: "시스템",
      text: `${game.phases[room.phaseIndex].label} 단계로 자동 진행됐다.`,
    });
    changed = true;
  }
  return changed;
}

function addPlayer(room, name) {
  const game = gameConfigForRoom(room);
  if (room.status !== "lobby") throw httpError(409, "이미 시작된 방에는 참가할 수 없습니다.");
  if (room.players.length >= game.maxPlayers) {
    throw httpError(400, `이 방은 이미 ${game.maxPlayers}명으로 가득 찼습니다.`);
  }
  const player = {
    id: id("player"),
    name: cleanName(name),
    connected: true,
    joinedAt: now(),
    roleId: null,
    vote: null,
  };
  room.players.push(player);
  room.messages.push({
    id: id("msg"),
    type: "system",
    at: now(),
    author: "시스템",
    text: `${player.name} 님이 입장했다.`,
  });
  return player;
}

function addMessage(room, playerId, text) {
  const player = assertPlayer(room, playerId);
  const body = String(text || "").trim().slice(0, 400);
  if (!body) throw httpError(400, "메시지를 입력해 주세요.");
  room.messages.push({
    id: id("msg"),
    type: "chat",
    at: now(),
    author: player.name,
    playerId: player.id,
    text: body,
  });
  room.messages = room.messages.slice(-80);
}

function castVote(room, playerId, targetId, reason) {
  const player = assertPlayer(room, playerId);
  const game = gameConfigForRoom(room);
  if (room.status !== "playing") throw httpError(409, "진행 중인 게임이 아닙니다.");
  if (game.phases[room.phaseIndex].key !== "final" && game.phases[room.phaseIndex].key !== "reveal") {
    throw httpError(400, "최종 진술/투표 단계에서만 투표할 수 있습니다.");
  }
  const target = findVoteTarget(room, targetId);
  if (!target) throw httpError(400, "투표 대상을 찾을 수 없습니다.");
  player.vote = {
    targetId,
    reason: String(reason || "").trim().slice(0, 160),
    at: now(),
  };
  room.messages.push({
    id: id("msg"),
    type: "system",
    at: now(),
    author: "시스템",
    text: `${player.name} 님이 투표를 완료했다.`,
  });
}

function roleById(game, roleId) {
  return game.scenario.roles.find((role) => role.id === roleId) || null;
}

function findVoteTarget(room, targetId) {
  const game = gameConfigForRoom(room);
  return (
    game.scenario.solutionChoices?.find((choice) => choice.id === targetId) ||
    findPlayer(room, targetId) ||
    null
  );
}

function publicPlayers(room, reveal) {
  const game = gameConfigForRoom(room);
  return room.players.map((player) => {
    const role = roleById(game, player.roleId);
    return {
      id: player.id,
      name: player.name,
      connected: player.connected,
      isHost: player.id === room.hostId,
      roleName: role?.name || null,
      archetype: role?.archetype || null,
      publicInfo: role?.publicInfo || null,
      isKiller: reveal && game.scenario.killerRoleId ? role?.id === game.scenario.killerRoleId : undefined,
      voted: Boolean(player.vote),
    };
  });
}

function voteSummary(room, reveal, viewerId) {
  return room.players.map((player) => {
    const target = player.vote ? findVoteTarget(room, player.vote.targetId) : null;
    return {
      voterId: player.id,
      voterName: reveal || player.id === viewerId ? player.name : null,
      targetId: player.vote?.targetId || null,
      targetName: target ? target.name : null,
      reason: reveal || player.id === viewerId ? player.vote?.reason || "" : "",
      visible: reveal || player.id === viewerId,
      voted: Boolean(player.vote),
    };
  });
}

function visibleClues(room) {
  const game = gameConfigForRoom(room);
  const phaseIndexByKey = phaseIndexMap(game.phases);
  const currentIndex = room.status === "lobby" ? 0 : room.phaseIndex;
  return game.scenario.clues.filter((clue) => phaseIndexByKey[clue.unlockPhase] <= currentIndex);
}

function sanitize(room, viewerId) {
  autoAdvance(room);
  const game = gameConfigForRoom(room);
  const viewer = findPlayer(room, viewerId);
  const phase = game.phases[room.phaseIndex];
  const reveal = room.status === "finished" || phase?.key === "reveal";
  const myRole = viewer?.roleId ? roleById(game, viewer.roleId) : null;
  const remainingMs =
    room.status === "playing"
      ? room.paused
        ? room.pauseRemainingMs
        : Math.max(0, room.phaseEndsAt - now())
      : null;
  const elapsedMs =
    room.status === "playing" && room.phaseStartedAt
      ? Math.max(0, now() - room.phaseStartedAt)
      : null;

  return {
    code: room.code,
    gameId: game.id,
    status: room.status,
    hostId: room.hostId,
    viewerId,
    isHost: viewerId === room.hostId,
    game: {
      id: game.id,
      title: game.title,
      tagline: game.tagline,
      description: game.description,
      difficulty: game.difficulty,
      coverImage: game.coverImage,
    },
    scenario: {
      title: game.scenario.title,
      place: game.scenario.place,
      premise: game.scenario.premise,
      rules: game.scenario.rules,
      timeline: game.scenario.timeline,
      victim: game.scenario.victim,
      truth: reveal ? game.scenario.truth : null,
    },
    players: publicPlayers(room, reveal),
    solutionChoices: game.scenario.solutionChoices || null,
    maxPlayers: game.maxPlayers,
    minPlayers: minPlayersForGame(game),
    myRole,
    phases: game.phases,
    phaseIndex: room.phaseIndex,
    currentPhase: phase,
    phaseStartedAt: room.phaseStartedAt,
    phaseEndsAt: room.phaseEndsAt,
    remainingMs,
    elapsedMs,
    paused: room.paused,
    clues: visibleClues(room),
    messages: room.messages.slice(-80),
    votes: voteSummary(room, reveal, viewerId),
    reveal,
    totalRuntimeMinutes: game.phases.reduce((sum, phaseItem) => sum + phaseItem.minutes, 0),
  };
}

function broadcast(room) {
  const clients = streams.get(room.code);
  if (!clients) return;
  for (const client of clients) {
    client.res.write(`event: state\n`);
    client.res.write(`data: ${JSON.stringify(sanitize(room, client.playerId))}\n\n`);
  }
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_000_000) throw httpError(413, "요청이 너무 큽니다.");
  }
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw httpError(400, "JSON 형식이 올바르지 않습니다.");
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

async function handleApi(req, res, url) {
  try {
    if (req.method === "GET" && url.pathname === "/api/games") {
      sendJson(res, 200, { games: gameCatalog() });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/rooms") {
      const body = await readJson(req);
      const { room, playerId } = createRoom(body.name, body.gameId);
      sendJson(res, 201, { playerId, state: sanitize(room, playerId) });
      broadcast(room);
      return;
    }

    const roomMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{5})(?:\/([a-z-]+))?$/i);
    if (roomMatch) {
      const room = findRoom(roomMatch[1]);
      const action = roomMatch[2] || "state";

      if (req.method === "GET" && action === "state") {
        const playerId = url.searchParams.get("playerId");
        assertPlayer(room, playerId);
        sendJson(res, 200, { state: sanitize(room, playerId) });
        return;
      }

      if (req.method !== "POST") throw httpError(405, "지원하지 않는 메서드입니다.");
      const body = await readJson(req);

      if (action === "join") {
        const player = addPlayer(room, body.name);
        sendJson(res, 201, { playerId: player.id, state: sanitize(room, player.id) });
        broadcast(room);
        return;
      }
      if (action === "start") {
        startRoom(room, body.playerId);
        sendJson(res, 200, { state: sanitize(room, body.playerId) });
        broadcast(room);
        return;
      }
      if (action === "advance") {
        advanceRoom(room, body.playerId);
        sendJson(res, 200, { state: sanitize(room, body.playerId) });
        broadcast(room);
        return;
      }
      if (action === "pause") {
        togglePause(room, body.playerId);
        sendJson(res, 200, { state: sanitize(room, body.playerId) });
        broadcast(room);
        return;
      }
      if (action === "message") {
        addMessage(room, body.playerId, body.text);
        sendJson(res, 200, { state: sanitize(room, body.playerId) });
        broadcast(room);
        return;
      }
      if (action === "vote") {
        castVote(room, body.playerId, body.targetId, body.reason);
        sendJson(res, 200, { state: sanitize(room, body.playerId) });
        broadcast(room);
        return;
      }

      throw httpError(404, "알 수 없는 액션입니다.");
    }

    throw httpError(404, "API 경로를 찾을 수 없습니다.");
  } catch (error) {
    sendJson(res, error.status || 500, { error: error.message || "서버 오류가 발생했습니다." });
  }
}

function handleEvents(req, res, url) {
  const match = url.pathname.match(/^\/events\/([A-Z0-9]{5})$/i);
  if (!match) {
    res.writeHead(404).end();
    return;
  }

  let room;
  try {
    room = findRoom(match[1]);
    const playerId = url.searchParams.get("playerId");
    assertPlayer(room, playerId);

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const client = { id: id("stream"), playerId, res };
    if (!streams.has(room.code)) streams.set(room.code, new Set());
    streams.get(room.code).add(client);

    const player = findPlayer(room, playerId);
    if (player) player.connected = true;
    res.write(`event: state\n`);
    res.write(`data: ${JSON.stringify(sanitize(room, playerId))}\n\n`);
    broadcast(room);

    req.on("close", () => {
      streams.get(room.code)?.delete(client);
      if (streams.get(room.code)?.size === 0) streams.delete(room.code);
      const stillConnected = [...(streams.get(room.code) || [])].some(
        (stream) => stream.playerId === playerId,
      );
      const currentPlayer = findPlayer(room, playerId);
      if (currentPlayer && !stillConnected) currentPlayer.connected = false;
      broadcast(room);
    });
  } catch (error) {
    sendJson(res, error.status || 500, { error: error.message || "SSE 연결 실패" });
  }
}

async function serveStatic(req, res, url) {
  const requestPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const safePath = normalize(decodeURIComponent(requestPath)).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicDir, safePath);
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  try {
    const file = await readFile(filePath);
    const type =
      {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".svg": "image/svg+xml; charset=utf-8",
        ".json": "application/json; charset=utf-8",
      }[extname(filePath)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    res.end(file);
  } catch {
    const fallback = await readFile(join(publicDir, "index.html"));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(fallback);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/healthz") {
    sendJson(res, 200, { ok: true, rooms: rooms.size, uptime: Math.round(process.uptime()) });
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    await handleApi(req, res, url);
    return;
  }
  if (url.pathname.startsWith("/events/")) {
    handleEvents(req, res, url);
    return;
  }
  await serveStatic(req, res, url);
});

setInterval(() => {
  for (const room of rooms.values()) {
    if (autoAdvance(room)) broadcast(room);
  }
}, 1000);

server.listen(PORT, HOST, () => {
  console.log(`Murder mystery web app running at http://${HOST}:${PORT}`);
});
