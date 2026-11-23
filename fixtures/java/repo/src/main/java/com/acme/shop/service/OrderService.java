package com.acme.shop.service;

import com.acme.shop.model.Money;
import com.acme.shop.model.Order;
import com.acme.shop.model.User;

public class OrderService {

    public static int discountPercent(User user) {
        return user.kind() == null ? 0 : 5;
    }

    public Money charge(Order order) {
        order.markPaid();
        return order.total();
    }
}
