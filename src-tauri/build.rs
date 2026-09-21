fn main() -> Result<(), Box<dyn std::error::Error>> {
    // protox compiles the descriptors in-process, so no protoc is required on
    // the build machine. Mirrors the CLI's build script.
    let descriptors = protox::compile(
        [
            "proto/brainpod/tunnel/v1/broker.proto",
            "proto/brainpod/tunnel/v1/tunnel.proto",
        ],
        ["proto"],
    )?;

    tonic_build::configure()
        .build_server(false)
        .build_transport(false)
        .compile_fds(descriptors)?;

    tauri_build::build();

    Ok(())
}
