use windows_sys::Win32::Foundation::{POINT, RECT};
use windows_sys::Win32::Graphics::Gdi::{
    CreateRectRgn, DeleteObject, ExtCreateRegion, GetMonitorInfoW, MonitorFromPoint, SetWindowRgn,
    HRGN, MONITORINFO, MONITOR_DEFAULTTOPRIMARY, RDH_RECTANGLES, RGNDATA, RGNDATAHEADER,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetClientRect, GetWindowRect, SetWindowPos, SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER,
};

const STARTUP_MARGIN: i32 = 12;

pub fn position_bottom_right(window: &tauri::WebviewWindow) -> Result<(), String> {
    let hwnd = window.hwnd().map_err(|error| error.to_string())?.0;
    let monitor = unsafe { MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY) };
    let mut monitor_info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        rcMonitor: RECT::default(),
        rcWork: RECT::default(),
        dwFlags: 0,
    };
    let mut window_rect = RECT::default();
    if unsafe { GetMonitorInfoW(monitor, &mut monitor_info) } == 0
        || unsafe { GetWindowRect(hwnd, &mut window_rect) } == 0
    {
        return Err("could not read the desktop work area".to_string());
    }
    let (x, y) = bottom_right_position(
        monitor_info.rcWork,
        window_rect.right - window_rect.left,
        window_rect.bottom - window_rect.top,
        STARTUP_MARGIN,
    );
    if unsafe {
        SetWindowPos(
            hwnd,
            std::ptr::null_mut(),
            x,
            y,
            0,
            0,
            SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
        )
    } == 0
    {
        return Err("could not position the window".to_string());
    }
    Ok(())
}

pub fn bottom_right_position(
    work_area: RECT,
    window_width: i32,
    window_height: i32,
    margin: i32,
) -> (i32, i32) {
    (
        work_area.right - window_width - margin,
        work_area.bottom - window_height - margin,
    )
}

pub fn set_window_region(
    window: &tauri::WebviewWindow,
    source_width: u16,
    source_height: u16,
    runs: &[u16],
) -> Result<(), String> {
    let hwnd = window.hwnd().map_err(|error| error.to_string())?.0;
    let mut client = RECT::default();
    if unsafe { GetClientRect(hwnd, &mut client) } == 0 {
        return Err("could not read the window client area".to_string());
    }
    let rectangles = rectangles_from_runs(
        runs,
        source_width,
        source_height,
        client.right,
        client.bottom,
    );
    let region = create_region(&rectangles)?;
    if unsafe { SetWindowRgn(hwnd, region, 0) } == 0 {
        unsafe { DeleteObject(region) };
        return Err("could not apply the window region".to_string());
    }
    Ok(())
}

pub fn rectangles_from_runs(
    runs: &[u16],
    source_width: u16,
    source_height: u16,
    target_width: i32,
    target_height: i32,
) -> Vec<RECT> {
    if source_width == 0 || source_height == 0 || target_width <= 0 || target_height <= 0 {
        return Vec::new();
    }

    runs.chunks_exact(3)
        .filter_map(|run| {
            let [y, left, right] = [run[0], run[1], run[2]];
            if y >= source_height || left >= right || right > source_width {
                return None;
            }
            Some(RECT {
                left: scale_floor(left, source_width, target_width),
                top: scale_floor(y, source_height, target_height),
                right: scale_ceil(right, source_width, target_width),
                bottom: scale_ceil(y + 1, source_height, target_height),
            })
        })
        .collect()
}

fn scale_floor(value: u16, source: u16, target: i32) -> i32 {
    i32::from(value) * target / i32::from(source)
}

fn scale_ceil(value: u16, source: u16, target: i32) -> i32 {
    (i32::from(value) * target + i32::from(source) - 1) / i32::from(source)
}

pub fn create_region(rectangles: &[RECT]) -> Result<HRGN, String> {
    if rectangles.is_empty() {
        let region = unsafe { CreateRectRgn(0, 0, 0, 0) };
        return (!region.is_null())
            .then_some(region)
            .ok_or_else(|| "could not create an empty window region".to_string());
    }

    let bounds = rectangles.iter().fold(rectangles[0], |mut bounds, rect| {
        bounds.left = bounds.left.min(rect.left);
        bounds.top = bounds.top.min(rect.top);
        bounds.right = bounds.right.max(rect.right);
        bounds.bottom = bounds.bottom.max(rect.bottom);
        bounds
    });
    let header_size = std::mem::size_of::<RGNDATAHEADER>();
    let rectangle_bytes = std::mem::size_of_val(rectangles);
    let byte_count = header_size + rectangle_bytes;
    let word_size = std::mem::size_of::<usize>();
    let mut storage = vec![0usize; byte_count.div_ceil(word_size)];
    let data = storage.as_mut_ptr().cast::<u8>();
    let header = RGNDATAHEADER {
        dwSize: header_size as u32,
        iType: RDH_RECTANGLES,
        nCount: rectangles.len() as u32,
        nRgnSize: rectangle_bytes as u32,
        rcBound: bounds,
    };

    unsafe {
        std::ptr::write(data.cast::<RGNDATAHEADER>(), header);
        std::ptr::copy_nonoverlapping(
            rectangles.as_ptr().cast::<u8>(),
            data.add(header_size),
            rectangle_bytes,
        );
        let region = ExtCreateRegion(std::ptr::null(), byte_count as u32, data.cast::<RGNDATA>());
        (!region.is_null())
            .then_some(region)
            .ok_or_else(|| "could not create the window region".to_string())
    }
}
