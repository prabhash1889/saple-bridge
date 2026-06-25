//! Minimal Server-Sent Events line framing.
//!
//! Both providers stream SSE. `SseDecoder` accumulates raw byte-chunk strings and yields complete
//! events as they cross a blank-line boundary, buffering any partial trailing event for the next
//! chunk. CRLF is normalized to LF so the `\n\n` boundary check works regardless of the server's
//! line endings. Comment lines (`:` heartbeat) are skipped.

/// A decoded SSE event: an optional `event:` name and the joined `data:` payload.
#[derive(Debug, Clone, PartialEq)]
pub struct SseEvent {
    pub event: Option<String>,
    pub data: String,
}

#[derive(Default)]
pub struct SseDecoder {
    buf: String,
}

impl SseDecoder {
    pub fn new() -> Self {
        Self { buf: String::new() }
    }

    /// Feed a chunk; return every complete event it (plus buffered remainder) now contains.
    pub fn push(&mut self, chunk: &str) -> Vec<SseEvent> {
        self.buf.push_str(&chunk.replace("\r\n", "\n"));
        let mut events = Vec::new();
        while let Some(pos) = self.buf.find("\n\n") {
            let block = self.buf[..pos].to_string();
            self.buf.drain(..pos + 2);
            if let Some(ev) = parse_block(&block) {
                events.push(ev);
            }
        }
        events
    }
}

fn parse_block(block: &str) -> Option<SseEvent> {
    let mut event = None;
    let mut data_lines: Vec<String> = Vec::new();
    for line in block.lines() {
        let line = line.trim_end_matches('\r');
        if line.is_empty() || line.starts_with(':') {
            continue;
        }
        if let Some(rest) = line.strip_prefix("event:") {
            event = Some(rest.trim().to_string());
        } else if let Some(rest) = line.strip_prefix("data:") {
            // Per spec a leading single space after the colon is stripped.
            data_lines.push(rest.strip_prefix(' ').unwrap_or(rest).to_string());
        }
    }
    if data_lines.is_empty() {
        return None;
    }
    Some(SseEvent {
        event,
        data: data_lines.join("\n"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_events_on_blank_line() {
        let mut d = SseDecoder::new();
        let evs = d.push("event: message_start\ndata: {\"a\":1}\n\nevent: ping\ndata: {}\n\n");
        assert_eq!(evs.len(), 2);
        assert_eq!(evs[0].event.as_deref(), Some("message_start"));
        assert_eq!(evs[0].data, "{\"a\":1}");
        assert_eq!(evs[1].event.as_deref(), Some("ping"));
    }

    #[test]
    fn buffers_partial_event_across_chunks() {
        let mut d = SseDecoder::new();
        assert!(d.push("data: hel").is_empty());
        assert!(d.push("lo\n").is_empty());
        let evs = d.push("\n");
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].data, "hello");
    }

    #[test]
    fn normalizes_crlf() {
        let mut d = SseDecoder::new();
        let evs = d.push("data: x\r\n\r\n");
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].data, "x");
    }

    #[test]
    fn skips_comments_and_handles_done_sentinel() {
        let mut d = SseDecoder::new();
        let evs = d.push(": heartbeat\ndata: [DONE]\n\n");
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].data, "[DONE]");
    }
}
