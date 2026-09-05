use codexpet_lib::window_region::{bottom_right_position, create_region, rectangles_from_runs};
use windows_sys::Win32::Foundation::RECT;
use windows_sys::Win32::Graphics::Gdi::{DeleteObject, PtInRegion};

#[test]
fn positions_window_at_the_work_area_bottom_right() {
    let work_area = RECT {
        left: -1920,
        top: 40,
        right: 0,
        bottom: 1080,
    };

    assert_eq!(bottom_right_position(work_area, 400, 560, 12), (-412, 508));
}

#[test]
fn scales_alpha_runs_without_filling_transparent_gaps() {
    let rectangles = rectangles_from_runs(&[0, 1, 3, 0, 4, 5, 2, 0, 5], 5, 3, 10, 6);
    let coordinates = rectangles
        .iter()
        .map(|rect| (rect.left, rect.top, rect.right, rect.bottom))
        .collect::<Vec<_>>();

    assert_eq!(
        coordinates,
        vec![(2, 0, 6, 2), (8, 0, 10, 2), (0, 4, 10, 6)]
    );
}

#[test]
fn native_region_excludes_a_transparent_gap() {
    let rectangles = rectangles_from_runs(&[0, 1, 3, 0, 4, 5], 5, 1, 10, 2);
    let region = create_region(&rectangles).expect("region should be created");

    unsafe {
        assert_ne!(PtInRegion(region, 3, 1), 0);
        assert_eq!(PtInRegion(region, 7, 1), 0);
        assert_ne!(PtInRegion(region, 9, 1), 0);
        DeleteObject(region);
    }
}
