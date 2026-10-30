# Định hướng Event Tracking QA theo yêu cầu nghiệm thu

Ngày rà soát: 30/10/2026. Phạm vi: source hiện tại, tài liệu dự án và workbook `Martech_AppOTA_Insider_20260801.xlsx` người dùng cung cấp. Những phần ghi “cần làm” chưa phải chức năng đã bàn giao.

**Luồng hiện hành:** giao diện đã chuyển sang nhập file, chọn website/luồng, hướng dẫn từng thao tác và bảng event/params mong muốn so với thực tế. Xem [hướng dẫn sử dụng hiện tại](GUIDED_WORKFLOW.md). Nội dung rà soát dưới đây được giữ làm lịch sử; các giới hạn về context độc lập, vendor ingestion và native App vẫn áp dụng.

**Cập nhật sau rà soát:** người dùng đã bổ sung file WebOTA và yêu cầu gói Windows chạy trên máy cá nhân. Bản đóng gói kế tiếp bổ sung lưu key qua giao diện, AI dùng yêu cầu từng event trong file Web, model free trước/rẻ nhất sau và tách nguồn/luồng. Auto coverage đã được sửa để rule nháp và field động thiếu context giữ REVIEW. Xem [đánh giá file Web](WEB_SPEC_REVIEW.md); các nhận xét bên dưới về lỗi trước sửa được giữ làm lịch sử rà soát, không thay thế kiểm chứng bản phát hành.

**Phạm vi người dùng đã chốt:** làm tốt bản Web trước. QC tự thao tác, hệ thống tự thu thập, kiểm tra và báo lỗi. Native App và tự động thực hiện thao tác không nằm trong điều kiện nghiệm thu bản Web đầu tiên.

Người dùng xác định workbook là **file tham khảo**, không phải hợp đồng nghiệm thu Web đã duyệt. File gửi lại có cùng nội dung với file đã phân tích (SHA-256 `f1ffdf4a7d33fc31a3b01e796d74385b4162b78be74bdb244ff736d1cd03f2e7`). Các trigger và quy tắc trích từ file phải đi qua bước mapping/duyệt cho Web trước khi tạo kết luận nghiệm thu.

Mục tiêu là giảm công việc QC phải tự tìm event, so từng tham số và viết lỗi cho dev. Đơn vị nghiệm thu phải là **một kịch bản trên một nền tảng và một luồng nghiệp vụ**, có các bước thao tác, event mong đợi và dữ liệu kiểm chứng độc lập.

## 1. Kết luận sau khi đọc dự án

Kiến trúc dùng chung collector, rule engine, evidence store và report có thể giữ lại. Phần triển khai hiện tại tập trung nhiều vào thu và hiển thị event; còn khoảng cách đáng kể tới nghiệm thu đúng trigger và đúng giá trị nghiệp vụ trên cả Web và App.

| Phần | Bằng chứng trong source | Khoảng cách với yêu cầu |
|---|---|---|
| Thu Web | `src/collectors/cdp.mjs`, `inject.js`, `proxy.mjs`, `core/decoder.mjs` | Có queue và request; cần hợp đồng rõ từng vendor/tầng, và quy kết vào thao tác của kịch bản. |
| Nhập requirements | `src/spec/import.mjs` đọc XLSX/JSON, giữ sheet/dòng, tạo rule nháp | Mỗi dòng event đang thành một case; chưa xây thành kịch bản nhiều bước. Nội dung mô tả trigger, công thức và hướng dẫn SDK chưa được chuyển đầy đủ thành kiểm tra. |
| So sánh theo bước | `src/core/session.mjs`, `rules.mjs` có context, count, order, thời gian và review gate | Phạm vi hiện tại dựa vào Start/Complete Step; thời gian tính từ lúc bắt đầu bước, chưa phải mốc thao tác thực tế. Rule engine chưa ràng buộc flow một cách độc lập với việc gán step. |
| Đối chiếu tự động | `src/core/catalog.mjs` gắn event vào dòng đặc tả | `ref` bị hạ thành kiểm tra có mặt; nhánh này chưa áp dụng review gate như kiểm tra theo bước. “MATCH” ở đây không phải kết quả nghiệm thu. |
| Giá trị động | Rule engine có `ref=context.*` | Importer chủ yếu suy kiểu dữ liệu từ sample; R1511 hiện có 0 rule `ref`. Chưa xác nhận giá, ngày, số người, sản phẩm đúng với lựa chọn thực tế. |
| Mảng và tính toán | Có nested path, index, subset | Rule suy từ sample chỉ đi vào phần tử đầu của mảng object. Chưa có kiểm tra mọi phần tử và quan hệ như tổng số người, tổng tiền, tập sản phẩm. |
| AI | `src/ai/openrouter.mjs`: tạo case nháp và giải thích kết quả | Chưa có quy trình đọc toàn bộ requirements, tách kịch bản, phát hiện mâu thuẫn và duyệt mapping theo phiên bản. AI chưa tự thao tác Web/App. |
| Báo cáo | `src/report/export.mjs`: XLSX, HTML, JSON, Markdown, expected/actual/evidence | Cần thêm phiên bản app/web/spec, thao tác tái hiện, context và kết quả từng vendor. Hiện nhánh coverage có thể sinh bug từ rule nháp, cần cùng review gate với kết quả nghiệm thu. |
| App Android/iOS | Chưa có native collector trong đường chạy `src/cli.mjs` | CDP desktop không quan sát được Insider/Firebase SDK trong App. Proxy Web hiện tại không tự trở thành bộ thu native SDK. |
| Phân phối | Có ZIP Windows kèm Node, 3 chế độ dùng chung core | Giữ cách chạy portable; ba chế độ là tùy chọn kỹ thuật thu dữ liệu, không thay thế lựa chọn Web/App, Golf/Flight và kịch bản. |

Tại thời điểm rà soát ban đầu, source có thay đổi cục bộ để tách luồng, nguồn quan sát và bóc event trong `Ucd:event:beforeSend`; ZIP ở `4b0b600` chưa chứa các thay đổi đó. Bản portable được đóng gói sau rà soát thay thế ZIP này.

## 2. Những gì workbook thực tế cho thấy

- Workbook là **AppOTA / Insider Mobile SDK**. Không mặc định mọi field riêng của App như device/app version đều bắt buộc ở Web. Phải duyệt hợp đồng Web và App riêng.
- R1511 có 8 event Golf, R3110 có 7 event Merchandise ở dạng JSON `event/default_parameters/custom_parameters`; importer hiện đọc được các mẫu này.
- R3107, 3107 có ví dụ mã SDK; R3108 có yêu cầu tham số bằng văn bản. Lượt rà soát hiện tại chưa đọc được các ô đó thành payload JSON. Cần trích xuất requirements và duyệt; không thực thi mã trong workbook.
- `Adjust Event` là một vendor riêng. Hiện importer gán các dòng này thành INSIDER theo tên workbook — sai phân loại. `Test_app_VP-OTA 1809` cũng bị nhập như event spec, gồm cả một dòng tiêu đề lặp. Cần phân loại sheet trước khi nhập.
- Các sheet có thể là nhiều revision và loại tài liệu khác nhau: đặc tả, user attributes, hướng dẫn SDK, kết quả test cũ. Chọn revision đã duyệt cho từng phạm vi; không gộp toàn bộ và không chọn bản mới chỉ theo tên sheet.
- R1511 mô tả `golf_checkout` phát **khi user nhấn Thanh toán ở màn checkout và chuyển sang màn chọn phương thức thanh toán**. Đây là trigger tham khảo để đề xuất hợp đồng Web. Việc thấy payload có đúng tên chưa chứng minh đúng trigger.
- Mô tả `listing_page_view` và `search_golf` trong R1511 cần được BA/QC xem lại: một dòng nói submit form, dòng còn lại nói vào trang kết quả. Giữ nguyên yêu cầu và đánh dấu điểm cần làm rõ, không âm thầm sửa theo suy đoán.

## 3. Quy trình sử dụng cần xây

**Chọn Web/Android/iOS → chọn phiên bản requirements → chọn Golf/Flight/... → chọn kịch bản → điền dữ liệu test → thực hiện từng bước → kiểm tra tự động → xem lỗi và xuất doc.**

Phương án đã chốt cho bản đầu: QC thao tác trên website; hệ thống tự thu, đối chiếu và lập báo cáo. Tự động thực hiện thao tác là một giai đoạn riêng nếu người dùng cần. Thiết kế collector/rule engine không phụ thuộc cách thao tác để có thể bổ sung sau.

Một kịch bản chứa nhiều bước. Mỗi bước xác định:

1. Điều kiện trước khi chạy và hành động cụ thể; có mốc bắt đầu/kết thúc và mốc trigger.
2. Dữ liệu đã chọn: sân, ngày chơi, tee time, số người hoặc chuyến bay, ngày bay, số khách.
3. Event mong đợi **riêng cho từng vendor và tầng cần kiểm**; số lần, thứ tự, thời gian, điều kiện không được bắn.
4. Expected của từng field và nguồn của expected: cố định từ requirement, lựa chọn QC, UI hoặc API nghiệp vụ độc lập đã được xác định.
5. Kết quả, trường sai, expected/actual, bằng chứng và vị trí requirements.

Expected không được sao chép từ chính tracking payload đang cần kiểm. Sample Hải Phòng không phải expected cố định khi QC đang chọn sân Léman. Không dùng Excel điền các field thiếu vào actual.

Giao diện chính ưu tiên danh sách kịch bản, tiến độ bước, kết quả event/params và lỗi. JSON gốc và log SDK nằm trong phần chi tiết để chẩn đoán. Giữ ba chế độ CDP / CDP+AI / Proxy trong phần thiết lập.

## 4. Thu event ở đâu và tách luồng thế nào

| Đối tượng | Bằng chứng cần thu | Điều có thể kết luận |
|---|---|---|
| Web GA4 | `dataLayer`/`gtag` khi requirement kiểm bước push; request GA4 khi kiểm bước gửi | Push đúng và request đúng là hai kiểm tra riêng. |
| Web Insider | `InsiderQueue` hoặc SDK call khi requirement yêu cầu; request gửi tới endpoint event Insider | Trong request/envelope, đọc từng `events[].event_name` và `event_params`. `Ucd:event:beforeSend` là hook quan sát SDK, không phải business event. |
| App Insider / GA4 | Adapter nhận event từ bản QA/debug: log SDK hoặc cầu nối ghi event có cấu trúc; bổ sung network khi đọc được | Log trước SDK không bảo đảm đã thấy mọi tham số SDK tự thêm hoặc dữ liệu server bổ sung. |
| Vendor nhận dữ liệu | DebugView/console, export hoặc API được vendor hỗ trợ và được cấp quyền | Chỉ đánh dấu đã xác nhận ingestion khi có bằng chứng tương ứng. HTTP 200/204 chưa đủ. |

Mặc định màn xem dữ liệu gửi đi của Web ưu tiên request theo vendor đã chọn. Khi chạy nghiệm thu, tầng cần kiểm do requirement quyết định; không ép mọi requirement thành kiểm request.

Một thao tác có thể tạo queue → SDK → request và cùng lúc gửi GA4 + Insider. Đó là các bằng chứng của thao tác, không mặc định là nhiều event trùng. Giữ nguyên các quan sát gốc; chỉ liên kết khi có đủ bằng chứng về tab/phiên, tên đã mapping, mã nghiệp vụ, nội dung và thời điểm. Batch hoặc mapping không rõ phải giữ trạng thái chưa xác định. Hai request thực sự gửi lặp trong cùng bước vẫn phải được đếm và kiểm theo requirement.

Khóa phạm vi cần có: `run → platform/environment/build → flow → scenario → step → action → vendor → observation layer`. Không match chỉ theo tên event. `cart_page_view` của Flight không được đáp ứng case Golf. URL, taxonomy, service, mã sân/chuyến bay là bằng chứng hỗ trợ; khi xung đột phải báo rõ, không đổi nhãn mọi event thành luồng người dùng đang chọn. Bộ lọc hiển thị không được làm mất bằng chứng event phát nhầm luồng. Các bước chung như login/payment cần mapping phạm vi được duyệt; chưa đủ căn cứ thì để “chưa xác định”.

Trên Windows, bản Web portable tiếp tục dùng được. App cần nguồn thu riêng: bản Android/iOS QA có hỗ trợ từ dev là hướng ưu tiên. Proxy có thể không đọc được TLS pinning hoặc payload native SDK; chỉ có app phát hành chưa đủ để cam kết bắt đầy đủ. Windows không chạy iOS Simulator; có thể nhận log từ thiết bị QA hoặc hạ tầng test phù hợp.

## 5. AI đảm nhiệm phần nào

AI hỗ trợ đọc mô tả và mẫu để đề xuất kịch bản, trigger, mapping vendor, rule tham số, ca âm và điểm chưa rõ. Mỗi đề xuất phải dẫn được sheet/dòng/nội dung nguồn; giá trị chưa rõ được để pending. QC/BA duyệt hợp đồng một lần và quản lý phiên bản để tái sử dụng cho regression, không phải duyệt lại mỗi event.

Kết quả phải do bộ kiểm tra có quy tắc thực hiện: field bắt buộc/kiểu/enum; đối chiếu lựa chọn; kiểm mọi item; công thức tổng; trigger, count, order và timing. AI giải thích chênh lệch, gom lỗi cùng nguyên nhân khi có căn cứ và soạn bug cho dev. AI không tự sinh actual, tự xác nhận ingestion hay biến dữ liệu chưa đủ thành PASS.

Nếu `items` được SDK gửi dưới dạng chuỗi theo mẫu, cần bộ đọc đúng định dạng đã duyệt để kiểm từng tee time; nếu chưa đọc được thì đánh dấu phần kiểm đó chưa đủ bằng chứng. Với ngày/giờ phải có quy ước timezone và định dạng rõ, không tự xem ISO UTC và ngày nghiệp vụ là hai giá trị khác nhau.

Trạng thái cần phân biệt: chưa chạy; đang chờ event/batch; chưa đủ bằng chứng hoặc rule chưa duyệt; không áp dụng; PASS; FAIL. Không thấy event chỉ là FAIL sau khi bước đúng đã thực hiện, collector quan sát được tầng đó và hết cửa sổ chờ đã duyệt.

## 6. Thứ tự triển khai và tiêu chí nghiệm thu

| Mốc | Việc cần làm | Cách chứng minh đạt |
|---|---|---|
| 1. Chốt hợp đồng | Phân loại sheet/vendor/platform/revision; chuẩn hóa event, trigger và params; giữ điểm mâu thuẫn để review | Từ R1511 đề xuất hợp đồng Web Golf có nguồn và điều kiện đã duyệt; Adjust/test results không bị nhập nhầm; App/Web khác nhau được thể hiện rõ. |
| 2. Hoàn chỉnh một kịch bản Web Golf | Gắn từng bước với trigger, lấy expected độc lập, so actual theo từng vendor/tầng; xử lý batch và chờ event | Chạy từ tìm sân/chọn tee time tới checkout theo dữ liệu test; kiểm mọi item, số người, giá và ngày theo quy tắc được duyệt; không tạo giao dịch thật nếu chưa nằm trong phạm vi test. |
| 3. Chứng minh tách luồng và bắt lỗi | Bổ sung một kịch bản Flight và các ca lỗi có chủ đích | Golf và Flight dùng chung tên event vẫn không khớp chéo; một thao tác có nhiều tầng không báo trùng giả; hai lần gửi thật vẫn hiện; bắt được sai trigger, thiếu/sai params, trùng và thiếu event. |
| 4. Hoàn thiện báo cáo và AI | Thống nhất verdict/review gate giữa coverage, step và report; AI tạo nháp từ requirements, giải thích và viết bug | Mỗi FAIL có thao tác tái hiện, build/platform/flow/vendor, rule nguồn, expected/actual và evidence; rule pending không thành bug nghiệm thu. |
| 5. Mở rộng regression Web | Nhân rộng hợp đồng đã duyệt sang Hotel, Merchandise và các luồng còn lại | Ma trận trình duyệt × luồng × vendor × kịch bản có độ phủ rõ; bộ hồi quy phát hiện lại các lỗi đã cài có chủ đích. |
| Giai đoạn sau: Native App | Khi người dùng mở phạm vi App: làm PoC một event Insider và một event GA4 trên bản QA; sau đó dùng chung kịch bản/rule/report | Có evidence thật từ App và phạm vi tham số quan sát được; chạy được trên thiết bị mục tiêu. Sau PoC mới cam kết mở rộng kịch bản Android/iOS. |

Đầu ra cho dev cần có cả báo cáo tổng và từng bug: phiên bản test/spec, các bước tái hiện, trigger mong đợi/thực tế, đường dẫn field, expected và nguồn expected, actual, raw JSON đã che dữ liệu, thời gian và evidence ID. JSON/XLSX/HTML/Markdown hiện có là nền tảng; chưa có xuất DOCX.

## 7. Kiểm chứng trong lượt rà soát này

Các kết quả sau chạy trên working tree hiện tại, gồm các thay đổi cục bộ chưa đóng gói; không phải xác nhận lại ZIP đã phát hành.

- Chạy importer trên cả 10 sheet của workbook; xác nhận số mẫu đọc được, phân loại nhầm Adjust và test results, 8 event R1511 không có rule context.
- Dùng case tổng hợp cục bộ chứng minh auto matching có thể trả PASS dù destination khác context và rule còn nháp; kiểm theo bước phát hiện chênh lệch và giữ REVIEW. Đây là điểm cần sửa trước khi dùng coverage để nghiệm thu.
- `node --test test/*.test.mjs tests/*.test.mjs`: **156 PASS, 0 FAIL, 1 SKIP**. Bài live bên ngoài mặc định skip.
- `npm run check`: **52 file JavaScript** kiểm tra cú pháp thành công.
- `npm test`: **156 PASS, 1 FAIL, 1 SKIP**; file `cloud/tests/live.test.mjs` không nạp được vì thiếu `cloud/security.mjs`. Nhánh cloud còn tham chiếu tài nguyên Web riêng không có trong checkout, cần thống nhất với sản phẩm `src/` trước khi coi đây là đường chạy được hỗ trợ.
- Các kiểm tra trên chứng minh tình trạng source và khả năng phân tích file, chưa nghiệm thu luồng thật trên `vinpearlota.com` hoặc native App. Không có phép đo mới về hiệu năng website thật trong lượt rà soát này.

Ưu tiên đã chốt là hoàn chỉnh kịch bản Web Golf theo đúng requirements và kiểm tra Flight không bị lẫn, sau đó mở rộng AI và các luồng Web trên cùng nền tảng kiểm chứng. App để giai đoạn sau. Tiếp tục chỉ mở rộng danh sách event hoặc chỉnh giao diện sẽ chưa giải quyết được công việc nghiệm thu của QC.
