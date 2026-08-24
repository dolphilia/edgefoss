use std::process::ExitCode;

fn main() -> ExitCode {
    match ef_cli::run(std::env::args_os()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("error: {error}");
            ExitCode::FAILURE
        }
    }
}
