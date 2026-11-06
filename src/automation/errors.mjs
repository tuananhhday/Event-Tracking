export function actionLabel(action) {
  const target = action.locator?.value ? ` “${action.locator.value}”` : '';
  return ({ goto: 'Mở trang', click: 'Bấm', fill: 'Điền ô', select: 'Chọn giá trị tại', check: 'Đánh dấu ô', press: 'Nhấn phím tại', wait_for: 'Chờ', assert_text: 'Kiểm tra nội dung', assert_url: 'Kiểm tra địa chỉ trang' }[action.type] || action.type) + target;
}
export function actionFailure(error, action) {
  const detail = String(error?.message || error), label = actionLabel(action);
  if (error?.name === 'AbortError') return error;
  let message, code;
  if (/strict mode violation/i.test(detail)) {
    code = 'AUTOMATION_AMBIGUOUS_CONTROL'; message = `${label}: có nhiều thành phần cùng tên. Sửa tên ô/nút cho rõ hơn hoặc tạo lại kế hoạch sau khi đọc trang.`;
  } else if (/Target.*closed|browser.*closed|page.*closed|Kết nối tự động hóa đã dừng/i.test(detail)) {
    code = 'AUTOMATION_BROWSER_CLOSED'; message = `${label}: cửa sổ test hoặc kết nối Playwright đã đóng. Giữ cửa sổ test mở rồi chạy lại luồng.`;
  } else if (/not.*(?:input|textarea|editable)|not an.*element/i.test(detail) && action.type === 'fill') {
    code = 'AUTOMATION_NOT_EDITABLE'; message = `${label}: thành phần này không phải ô nhập văn bản. Sửa bước để chọn đúng ô nhập hoặc mô tả cách chọn giá trị rồi tạo lại kế hoạch.`;
  } else if (action.type === 'goto' && /net::|timeout|vượt quá/i.test(detail)) {
    code = 'AUTOMATION_NAVIGATION_FAILED'; message = 'Không mở được website trong thời gian chờ. Kiểm tra URL, mạng hoặc quyền truy cập website rồi chạy lại.';
  } else if (/Timeout|vượt quá|waiting for locator/i.test(detail) || error?.name === 'TimeoutError') {
    code = 'AUTOMATION_ACTION_TIMEOUT'; message = `${label}: chưa tìm thấy thành phần sẵn sàng hoặc kết quả mong muốn trong thời gian chờ. Kiểm tra tên ô/nút, popup che trang và trạng thái đăng nhập; sửa bước rồi lưu lại.`;
  } else return error;
  return Object.assign(new Error(message, { cause: error }), { code });
}
