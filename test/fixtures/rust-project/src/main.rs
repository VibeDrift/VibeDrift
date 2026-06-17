use serde::{Deserialize, Serialize};
use std::fs;

// TODO: handle errors properly
// FIXME: this is terrible

#[derive(Serialize, Deserialize)]
struct User {
    name: String,
    age: u32,
}

fn load_config() -> String {
    let content = fs::read_to_string("config.toml").unwrap();
    let parsed = content.parse::<String>().unwrap();
    let result = do_something(&parsed).unwrap();
    result
}

fn do_something(input: &str) -> Result<String, String> {
    Ok(input.to_string())
}

fn dangerous_operation() {
    unsafe {
        let ptr = 0x1234 as *mut u32;
        *ptr = 42;
    }
}

fn complex_function(x: i32, y: i32) -> i32 {
    if x > 0 {
        if y > 0 {
            if x > y {
                return x - y;
            } else if y > x {
                return y - x;
            } else {
                return 0;
            }
        } else {
            if x > -y {
                return x + y;
            } else {
                return -(x + y);
            }
        }
    } else {
        if y > 0 {
            if -x > y {
                return x + y;
            } else {
                return y + x;
            }
        } else {
            return x + y;
        }
    }
}
