# Nghiên cứu công cụ thu và kiểm tra GTM / GA4

Ngày đọc nguồn: 30/10/2026; cập nhật phạm vi áp dụng ngày 31/10/2026 (giờ Việt Nam). Mục tiêu là xác định **đang quan sát dữ liệu gì**, rồi mới đối chiếu requirements do người dùng chọn. Có extension không đồng nghĩa tự biết giá trị nghiệp vụ nào đúng.

## Phạm vi nguồn đã đọc

GitHub connector không có tool khả dụng trong phiên này; đã tìm repository bằng trang tìm kiếm GitHub và đọc source công khai qua HTTPS/Git, giữ proxy và TLS xác thực. Các trang `developers.google.com`, `support.google.com` bị proxy trả HTTP 403. Vì vậy các link Help chính thức bên dưới là tài liệu để đối chiếu, **không được trình bày như trang hiện hành đã đọc thành công**. Không truy cập tài khoản Analytics/GTM hoặc cài extension thật trong lượt nghiên cứu.

| Nguồn đã đọc | Snapshot | Điều xác minh được |
|---|---|---|
| [Google Data Layer Helper](https://github.com/google/data-layer-helper) | `4a65b385db1fac710d33bf5d1345e598e3d117fc` | Queue message, abstract model, recursive merge, `_clear`, listener và history |
| [Google Analytics Dev Tools](https://github.com/googleanalytics/ga-dev-tools) | `14217f42eca6358cfa973ce0e65bc128038ba42e` | Trang Tag Assistant đời cũ, link Google Analytics Debugger, GA4 Event Builder và MP validator |
| [Chrome DevTools Protocol](https://github.com/ChromeDevTools/devtools-protocol) | `a45ae55ca46eeb4c6768011da4470ec0f103d01c` | Network request lifecycle, POST body và các trường có thể không có |
| [Omnibug](https://github.com/MisterPhilip/omnibug) | `ce9a0aacbb98f0bf7994e1fd14a68307c7b71a75` | Extension đọc request bằng `webRequest`, ghép URL/POST, nhận diện vendor |
| [Analytics Debugger GA4MP](https://github.com/analytics-debugger/ga4mp) | `b2e66f0709b2be583561db4277a25469930b736f` | Mã hóa giao thức web GA4, item `prN`, event `ep.*`/`epn.*`, encoding query |

## Những công cụ nên dùng để đối chiếu độc lập

| Công cụ | Vai trò đối với EventQA | Giới hạn cần giữ rõ |
|---|---|---|
| GTM Preview / Tag Assistant | Công cụ Google để đối chiếu cấu hình tag, trigger và dữ liệu của phiên debug; dùng làm bước kiểm tra độc lập khi đội có quyền GTM | Không có adapter/private API của Tag Assistant được tích hợp ở đây. Không dùng tên tag đã fire làm bằng chứng vendor đã ghi dữ liệu |
| GA4 DebugView | Đối chiếu event ở phía property GA4 trong phiên debug được cấu hình đúng | Cần quyền property và cấu hình debug phù hợp; request 200/204 không thay cho bằng chứng này. Chưa kiểm tra UI/receipt trực tiếp |
| Google Analytics Debugger | Google Dev Tools repo dẫn tới extension có ID `jnkmfdileelhofjcijamephohjechhna` | Nguồn Google đọc được có nhiều nội dung `analytics.js` đời cũ. Không khẳng định extension hiện tại hỗ trợ toàn bộ GA4, hoặc publisher/version/permissions hiện tại đã được kiểm tra |
| Omnibug | Xem và đối chiếu request marketing gửi đi; source công khai cho biết cách đọc URL/POST và vendor | Là công cụ bên thứ ba, author trong manifest là Philip Lawrence; không phải extension Google. Source GA4 snapshot này còn nhiều mapping cũ, không dùng làm chuẩn duy nhất cho `prN` hiện đại |
| Chrome DevTools Network / HAR / CDP | Bằng chứng URL, body, thời điểm, request ID và lifecycle của browser | Không tự biết trạng thái variables/trigger trong GTM; body có thể không đọc được. HAR là request evidence, không thay dataLayer push |

Tài liệu chính thức để người dùng/đội GTM kiểm tra tiếp:

- [Google: dataLayer](https://developers.google.com/tag-platform/tag-manager/datalayer).
- [Google: Preview và debug container GTM](https://support.google.com/tagmanager/answer/6107056).
- [Google: GA4 DebugView](https://support.google.com/analytics/answer/7201382).
- [Google: bật DebugView cho GA4](https://developers.google.com/analytics/devguides/collection/ga4/debugview).
- [Chrome: Network reference](https://developer.chrome.com/docs/devtools/network/reference).

Không tự cài extension, tự bật debug mode trên production hoặc gửi lại tracking chỉ để tạo bằng chứng cho bài kiểm tra. Có thể dùng các công cụ trên làm bạn đồng hành đối chiếu, trong khi EventQA giữ kết quả thu riêng có nguồn rõ.

## 1. Raw push khác data model

[README của Google Data Layer Helper](https://github.com/google/data-layer-helper/blob/4a65b385db1fac710d33bf5d1345e598e3d117fc/README.md) nói rõ library vừa nhận message mới vừa cập nhật **abstract data model**. Objects/arrays cùng kiểu được merge đệ quy; scalar hoặc đổi kiểu ghi đè. `_clear` ngăn merge ở cấp tương ứng. Giá trị trước đó có thể vẫn tồn tại trong model khi push mới không chứa trường đó.

Listener nhận cả `(model, message)` — đây là hai đối tượng có nghĩa khác nhau. `listenToPast` là lựa chọn riêng cho history. Do đó:

- Giữ raw push làm bằng chứng app đã push gì tại đúng thời điểm.
- Có thể dựng declarative model để chẩn đoán trường kế thừa hoặc reset, với provenance tới push gốc.
- Model dựng lại không phải private runtime của container GTM. Custom variables, functions, tag template, consent hoặc transformations có thể làm dữ liệu tag gửi khác raw push.
- Không tự lấy field từ model đắp vào push rồi kết luận raw push đầy đủ. Không dùng backlog để đạt bước mới.
- Không chạy functions/custom commands từ tài liệu hoặc từ payload được thu chỉ để dựng model.

## 2. Request GA4 khác dataLayer ecommerce

[GA4MP `ga4Schema.js`](https://github.com/analytics-debugger/ga4mp/blob/b2e66f0709b2be583561db4277a25469930b736f/src/modules/ga4Schema.js) và [serializer `ga4mp.js`](https://github.com/analytics-debugger/ga4mp/blob/b2e66f0709b2be583561db4277a25469930b736f/src/ga4mp.js) cho thấy format web `pr1`, `pr2`… chứa các token phân tách bằng `~`. Các mapping đọc được gồm:

| Wire key | Trường item |
|---|---|
| `id`, `nm`, `br`, `va` | `item_id`, `item_name`, `item_brand`, `item_variant` |
| `ca`, `c2`…`c5` | `item_category`, `item_category2`…`item_category5` |
| `pr`, `qt`, `cp`, `ds` | `price`, `quantity`, `coupon`, `discount` |
| `ln`, `li`, `lp` | `item_list_name`, `item_list_id`, `index` |
| `af`, `pi`, `pn`, `cn`, `cs`, `lo` | `affiliation`, `promotion_id`, `promotion_name`, `creative_name`, `creative_slot`, `location_id` |

Custom item params dùng cặp `k{index}name` / `v{index}value`; index là `0`…`9` rồi `A`… theo serializer này. Event params có `ep.*` và numeric `epn.*`. Query encoding được làm bởi lớp request, nên không được decode URI lần hai vô điều kiện hoặc đoán giá trị của token lỗi.

Đây là **source bên thứ ba về client-side protocol**, không phải tài liệu Google cam kết format wire bất biến. Parser phải giữ nguyên raw `prN`, vị trí token, tên trường không biết và lý do chưa đọc được. Mô hình chuẩn hóa từ request không tự thành raw `dataLayer.ecommerce.items`.

## 3. Network evidence có giới hạn quan sát

[Official `Network.pdl`](https://github.com/ChromeDevTools/devtools-protocol/blob/a45ae55ca46eeb4c6768011da4470ec0f103d01c/pdl/domains/Network.pdl) nêu `hasPostData` có thể true trong khi `postData` bị bỏ khi body dài. `getRequestPostData` có thể lỗi và bỏ file trong multipart. Request/response/extraInfo là các lifecycle record; không tự đếm mỗi record thành một event mới. Batch có thể chứa nhiều business event nhưng vẫn một HTTP request.

[Omnibug service worker](https://github.com/MisterPhilip/omnibug/blob/ce9a0aacbb98f0bf7994e1fd14a68307c7b71a75/src/serviceWorker.js) đọc `webRequest.onBeforeRequest` với `requestBody` và giữ tab/request ID. Đây là bằng chứng cho hướng thu request, không phải bảo đảm implementation cũ xử lý mọi encoding/body chunk. Không sao chép parser cũ rồi gọi đó là đủ mọi trường hợp.

## 4. Validation API không phải cơ chế thu event

[Google GA4 Event Builder validator](https://github.com/googleanalytics/ga-dev-tools/blob/14217f42eca6358cfa973ce0e65bc128038ba42e/src/components/ga4/EventBuilder/ValidateEvent/useValidateEvent.ts) POST JSON tới `/debug/mp/collect` để đọc `validationMessages`; hàm gửi hit dùng `/mp/collect` riêng. Đây là Measurement Protocol JSON, không phải browser `/g/collect`.

Một phản hồi validation chỉ là kiểm tra payload được đưa vào validator. Nó không chứng minh thao tác browser đã tạo payload đó, không chứng minh tag GTM đúng trigger, và không phải receipt của request web thực tế.

## Áp dụng vào bản xây lại

1. Người dùng chọn rõ từng requirement/event/vendor; chỉ các ID đã chọn mới nằm trong kế hoạch test và mẫu số độ phủ.
2. Bộ thu giữ raw push, model khai báo suy ra, SDK dispatch và request thành các loại bằng chứng riêng; mapping có provenance và trạng thái chưa biết. Model không phải private state GTM. Vendor receipt cần đối chiếu riêng; bản này chưa thu tự động từ GA4/Insider.
3. So từng event và từng item theo yêu cầu; type/presence khác kiểm đúng giá trị. Field chưa có expected độc lập vẫn hiển thị chưa xác minh, không thành “đầy đủ”.
4. Không thu/giải mã được, sample mâu thuẫn, branch bỏ qua, requirement chưa chạy hoặc nguồn chưa đúng phải phân biệt với lỗi website.
5. Có liên kết mở Tag Assistant/DebugView để đối chiếu thủ công; không giả vờ đọc private state/API của các công cụ đó. Chưa tích hợp extension hoặc chức năng nhập HAR.

## License và cách dùng nguồn

Google Data Layer Helper và GA Dev Tools: Apache-2.0. Chrome DevTools Protocol: BSD-style license trong repo. Omnibug và Analytics Debugger GA4MP: MIT theo LICENSE đã đọc. Nghiên cứu này dùng để hiểu hành vi và viết parser độc lập; không vendor/copy nguyên extension hoặc thư viện vào app. Nếu về sau chép mã nguồn thì phải giữ notice/license tương ứng. Không suy từ license của GA4MP rằng mọi sản phẩm/extension Analytics Debugger có cùng license.
