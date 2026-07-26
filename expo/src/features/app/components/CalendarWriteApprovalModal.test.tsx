import { render } from "@testing-library/react-native";
import { CalendarWriteApprovalModal } from "./CalendarWriteApprovalModal";

const request = {
  operation: "calendar_create_event",
  signal: new AbortController().signal,
  view: {
    title: "歯医者",
    start: "2026-07-27T05:00:00.000Z",
    end: "2026-07-27T06:00:00.000Z",
    allDay: false,
    timeZone: "Asia/Tokyo",
    location: null,
    notes: null,
    calendarId: "calendar-1",
    lastModifiedAt: null,
    recurring: false,
    allowsModifications: true,
  },
} as const;

test("shows calendar dates in a readable local format", async () => {
  const view = await render(<CalendarWriteApprovalModal request={request} onDecide={jest.fn()} />);

  expect(view.getByText(/開始: .*2026.*7.*27.*14:00/)).toBeTruthy();
  expect(view.getByText(/終了: .*2026.*7.*27.*15:00/)).toBeTruthy();
  expect(view.queryByText(/2026-07-27T05:00:00\.000Z/)).toBeNull();
});
