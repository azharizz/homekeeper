export function RoomTrace() {
  return (
    <section
      id="roomtrace"
      tabIndex={-1}
      className="roomtrace-workspace"
      aria-label="RoomTrace"
    >
      <iframe
        src="/roomtrace/"
        title="RoomTrace 3D workspace"
        allow="camera 'self'; clipboard-write 'self'"
      />
    </section>
  );
}
