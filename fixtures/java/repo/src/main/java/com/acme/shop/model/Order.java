package com.acme.shop.model;

import com.acme.shop.service.OrderService;
import com.acme.shop.util.Strings;
import java.util.ArrayList;
import java.util.List;

public class Order extends Entity {

    private final User owner;
    private final List<Line> lines = new ArrayList<>();
    private Status status = Status.NEW;

    public Order(User owner) {
        super(1L);
        this.owner = owner;
    }

    public User owner() {
        return owner;
    }

    public void addLine(String sku, int quantity) {
        lines.add(new Line(sku, quantity));
    }

    public Money total() {
        Money sum = Money.of(0L);
        for (Line line : lines) {
            sum = sum.plus(line.cost());
        }
        Totals totals = new Totals();
        return totals.discounted(sum);
    }

    public String summary() {
        return status.label() + ":" + describe();
    }

    public void markPaid() {
        status = status.next();
        touch();
    }

    @Override
    public String kind() {
        return "order";
    }

    static class Line {

        private final String sku;
        private final int quantity;

        Line(String sku, int quantity) {
            this.sku = sku;
            this.quantity = quantity;
        }

        Money cost() {
            return Money.of(quantity * 100L);
        }

        String label() {
            return Strings.slug(sku);
        }
    }

    private class Totals {

        Money discounted(Money base) {
            int rate = OrderService.discountPercent(owner());
            return base.minusPercent(rate);
        }
    }
}
