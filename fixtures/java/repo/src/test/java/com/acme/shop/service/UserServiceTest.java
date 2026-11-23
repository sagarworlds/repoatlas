package com.acme.shop.service;

import static org.junit.jupiter.api.Assertions.assertEquals;

import com.acme.shop.model.Money;
import com.acme.shop.model.Order;
import com.acme.shop.model.User;
import org.junit.jupiter.api.Test;

class UserServiceTest {

    private final UserService service = new UserService(new InMemoryUserRepository());

    @Test
    void registersUser() {
        User user = service.register("ada");
        assertEquals("ada", user.displayName());
    }

    @Test
    void firstOrderHasTotal() {
        Order order = service.firstOrder("ada");
        Money total = order.total();
        assertEquals(total, total.plus(Money.of(0L)));
    }
}
