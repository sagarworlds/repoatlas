package com.acme.shop.model;

public record Money(long cents, String currency) {

    public static Money of(long cents) {
        return new Money(cents, "EUR");
    }

    public Money plus(Money other) {
        return new Money(cents + other.cents, currency);
    }

    public Money minusPercent(int percent) {
        return new Money(cents - cents * percent / 100, currency);
    }
}
