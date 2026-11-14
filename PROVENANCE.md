# Source provenance

The initial static UI comes from `zqcli/minicore-tui`, commit
`2451d7289214385e3d21b46174b36f32a41dce45`, directory `src/remote/web`.
This is the last source checkpoint before the embedded-Host migration removed
the webpage. Its webpage assets match the 0.9.9 release checkpoint
`3beeb1d8a525e58ce6352e05061f242c5580e248`.

The original MIT and Apache-2.0 license files are preserved. The imported Phone
protocol is being replaced by MiniCore Host's native WSS client contract; visual
and rendering behavior are the migration baseline, not the previous backend.
