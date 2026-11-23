package com.acme.shop.util;

/** A tiny generic success-or-error holder. */
public final class Result<T> {

    private final T value;
    private final String error;

    private Result(T value, String error) {
        this.value = value;
        this.error = error;
    }

    public static <T> Result<T> ok(T value) {
        return new Result<>(value, null);
    }

    public static <T> Result<T> fail(String error) {
        return new Result<>(null, error);
    }

    public boolean isOk() {
        return error == null;
    }

    public T value() {
        return value;
    }

    public <R> Result<R> andThen(Result<R> next) {
        return isOk() ? next : Result.fail(error);
    }
}
