import { Component, createRef } from "react";

// Camera hardware has an explicit lifetime. React owns the controls and preview.
export default class Camera extends Component {
  video = createRef();
  generation = 0;
  stream = null;
  canvas = null;
  state = { active: false, busy: false, error: "" };

  componentWillUnmount() {
    this.stop(false);
    this.props.onStop();
  }

  stop = (update = true) => {
    this.generation += 1;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    if (update) {
      this.setState({ active: false, busy: false });
      this.props.onStop();
    }
  };

  start = async () => {
    const generation = ++this.generation;
    this.setState({ busy: true, error: "" });
    try {
      if (!navigator.mediaDevices?.getUserMedia)
        throw new Error("Camera access requires HTTPS or localhost.");
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } },
        audio: false,
      });
      if (generation !== this.generation) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = stream;
      this.video.current.srcObject = stream;
      await this.video.current.play();
      this.setState({ active: true, busy: false });
      while (this.props.continuous && generation === this.generation) {
        await this.captureFrame(generation);
        // Capture cadence, not a request timeout. Backpressure keeps only one frame in flight.
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } catch (error) {
      if (generation === this.generation) {
        this.stop();
        this.setState({ error: error.message });
      }
    }
  };

  captureFrame = async (generation) => {
    const video = this.video.current;
    const canvas = (this.canvas ||= document.createElement("canvas"));
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const started = performance.now();
    const capturedAt = Date.now() / 1000;
    canvas.getContext("2d").drawImage(video, 0, 0);
    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.9),
    );
    if (generation !== this.generation) return;
    if (!blob)
      throw new Error(
        "The camera frame could not be encoded. Capture another view.",
      );
    await this.props.onFrame(
      blob,
      capturedAt,
      () => generation === this.generation,
      started,
    );
  };

  snapshot = async () => {
    const generation = this.generation;
    this.setState({ busy: true, error: "" });
    try {
      await this.captureFrame(generation);
    } catch (error) {
      if (generation === this.generation)
        this.setState({ error: error.message });
    } finally {
      if (generation === this.generation) this.setState({ busy: false });
    }
  };

  render() {
    return (
      <div className="camera">
        <video
          ref={this.video}
          muted
          playsInline
          aria-label="Live camera preview"
          hidden={!this.state.active}
        />
        <button
          type="button"
          className={this.state.active ? "danger" : ""}
          disabled={
            !this.state.active && (this.props.disabled || this.state.busy)
          }
          onClick={this.state.active ? () => this.stop() : this.start}
        >
          {this.state.active
            ? "Stop camera"
            : this.state.busy
              ? "Opening camera…"
              : "Open camera"}
        </button>
        {this.state.active && !this.props.continuous && (
          <button
            type="button"
            disabled={this.state.busy || this.props.disabled}
            onClick={this.snapshot}
          >
            {this.state.busy ? "Saving view…" : "Capture this view"}
          </button>
        )}
        {this.state.error && (
          <p role="alert" className="error">
            {this.state.error}
          </p>
        )}
      </div>
    );
  }
}
