package com.acme.shop.util;

public final class Strings {

    private Strings() {
    }

    public static String capitalize(String text) {
        return text == null ? "" : text.toUpperCase();
    }

    public static String slug(String text) {
        return pad(capitalize(text));
    }

    public static String pad(String text) {
        return pad(text, 8);
    }

    public static String pad(String text, int width) {
        return text + "/" + width;
    }

    public static String mask(String text) {
        return "***";
    }

    public static String mask(CharSequence text) {
        return "###";
    }
}
