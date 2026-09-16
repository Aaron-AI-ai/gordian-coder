---
exceptions: "org.apache.kafka.*", "*PBDaemonException", "*KafkaException", "*SerializationException", "*RecordDeserializationException", "*JMSException", "*AQException"
---
#### 데몬(Kafka/Solace/OracleAQ): 예외가 먹히고 커밋된다
- `DefaultKafkaConsumerRunnable`은 레코드마다 `catch (Exception e) { log.error("Consumer.listen() consumerRecord=…", e) }` 후 **`commitSync()`를 계속 진행**한다 — 실패한 메시지는 재처리되지 않고 유실된다. 로그 한 줄이 곧 유실 한 건이다.
- `PBDaemonException.create(code).withAckMode(AckMode.ACK|NACK|DEAD_LETTER).withRequeue(bool)` — 리스너가 이 값을 보고 ACK/NACK/DLQ를 결정한다. 지정하지 않으면 기본 ACK.
- `PBDaemonService`/`PBDaemonJournalLog`(site-ext daemon)가 저널을 남긴다. Solace는 ext `solace`, OracleAQ는 ext `oracleaq` 패키지.
- 역직렬화 오류(`SerializationException`)는 프로듀서 스키마 변경이 원인인 경우가 많다 — 코드가 아니라 상대 시스템.

확인 절차
1. `f_log_search`로 `consumerRecord=` 로그의 topic으로 리스너 클래스를 찾는다.
2. 리스너의 `listen` 메서드를 `f_log_read`로 열어 예외 타입과 ackMode 지정을 본다.
3. 페이로드 DTO를 `f_log_history`로 최근 변경 여부 확인.
4. `f_log_search`로 `PBDaemonJournalLog` 저널 기록 코드를 찾아 해당 topic의 실패 기록 여부를 본다.
5. Solace/OracleAQ라면 ext 패키지(`solace`/`oracleaq`)의 컨슈머 설정을 `f_log_read`로 확인한다.
