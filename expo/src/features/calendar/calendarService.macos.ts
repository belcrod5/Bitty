import { calendarError } from "./calendarToolSpecs";

function unavailable() {
  return calendarError("device_unavailable");
}

export async function getCalendarPermission() {
  return unavailable();
}

export async function requestCalendarPermission() {
  return unavailable();
}

export async function listCalendars() {
  return unavailable();
}

export async function searchEvents(_input: unknown) {
  return unavailable();
}

export async function getEvent(_input: unknown) {
  return unavailable();
}

export async function prepareCalendarWrite(_tool: string, _input: unknown) {
  return unavailable();
}

export async function createEvent(_input: unknown) {
  return unavailable();
}

export async function updateEvent(_input: unknown) {
  return unavailable();
}

export async function deleteEvent(_input: unknown) {
  return unavailable();
}
