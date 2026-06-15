Rate Limits
모든 API 는 클라이언트 × API 그룹 단위로 초당 요청 수(TPS)가 제한됩니다. 각 API 의 description 끝에 해당 API 가 속한 Rate Limits Group 이 표기됩니다. 구체적인 한도 수치는 운영 상황에 따라 사전 공지 없이 조정될 수 있으며, 현재 허용 한도는 응답 헤더로 확인할 수 있습니다.

Rate Limits Group	요청 한도	피크시간 한도
AUTH	초당 최대 5회	--
ACCOUNT	초당 최대 1회	--
ASSET	초당 최대 5회	--
STOCK	초당 최대 5회	--
MARKET_INFO	초당 최대 3회	--
MARKET_DATA	초당 최대 10회	--
MARKET_DATA_CHART	초당 최대 5회	--
ORDER	초당 최대 6회	09:00 ~ 09:10 KST: 초당 최대 3회
ORDER_HISTORY	초당 최대 5회	--
ORDER_INFO	초당 최대 6회	09:00 ~ 09:10 KST: 초당 최대 3회