package com.acme.shop.util;

public final class Validators {

    private Validators() {
    }

    public static String requireNonBlank(String value, String field) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(field + " must not be blank");
        }
        return value;
    }

    public static boolean isEmail(String value) {
        return value != null && value.contains("@");
    }
}
