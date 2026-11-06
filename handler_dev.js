import { ConfigWrapper, Events, FilterBuilder } from "klaviyo-api";
import { object, string, number, boolean, array, mixed } from 'yup';


/**
 * This endpoint will receive events from WEB and APP and pass them to
 * Klaviyo.
 * 
 * Retry Logic: The `ConfigWrapper` from Klaviyo comes with default retry logic.
 * @see https://github.com/klaviyo/klaviyo-api-node?tab=readme-ov-file#retry-options
 */
export default async (req, res) => {

    if (!process.env["KLAVIYO_PRIVATE_API_KEY"]) {
        throw new Error(
            "KLAVIYO_PRIVATE_API_KEY with events:read permissions must be set as an environment variable"
        );
    }

    let data, responseData;

    try {
        const result = await requestBodySchema.validate(req.body);

        data = result;
    } catch (e) {
        console.log(e);
        const errorObject = {
            message: `${process.env.ENV}: ` + e.errors + `\n`,
            dt: Math.floor(Date.now() / 1000)
        }

        // Send to BetterStack
        const ingestingHost = process.env["BETTERSTACK_HOST"];
        const sourceToken = process.env["BETTERSTACK_TOKEN"];

        const url = `https://${ingestingHost}`;

        await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${sourceToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(errorObject)
        })

        // Log
        console.error(JSON.stringify(errorObject, null, 2))

        return res.json(errorObject).status(200);
    }



    ConfigWrapper(process.env["KLAVIYO_PRIVATE_API_KEY"]);

    const klaviyoApi = new KlaviyoApi();

    const customActions = [
        'profile.get_user_info',
        'profile.unsubscribe_marketing',
        'profile.subscribe_marketing',

        'order.completed_preorder',
        'order.preordered_product',
        'analytics.send_event',
    ];

    if (data.action && !customActions.includes(data.action)) {
        /**
         * Create or Update Membership or Package Data Records
         */
        await createAndUpdateMemberhipOrPackageRecords(data);
    }

    switch (data.action) {
        case 'profile.created': {
            const {
                first_name,
                last_name,
                address_line1,
                birth_date,
                city,
                country,
                email,
                postal_code,
                is_opted_in_to_marketing,
                is_opted_in_to_sms,
                home_location,
                phone_number
            } = data.profile;

            try {
                await Events.createEvent({
                    data: {
                        type: 'event',
                        attributes: {
                            metric: {
                                data: {
                                    type: 'metric',
                                    attributes: {
                                        name: data.action,
                                    },
                                },
                            },
                            properties: {
                                email: email,
                            },
                            profile: {
                                data: {
                                    type: 'profile',
                                    attributes: {
                                        firstName: first_name,
                                        lastName: last_name,
                                        email: email,
                                        location: {
                                            country: country,
                                            address1: address_line1,
                                            city: city,
                                            zip: postal_code,
                                        },
                                        properties: {
                                            dob: birth_date,
                                            preferred_club: home_location.name,
                                        },
                                    },
                                },
                            },
                        },
                    },
                });
            } catch (e) {
                const errorObject = {
                    event_name: data.action,
                    message: e.message,
                    errors: e.response?.data.errors,
                };

                console.error(JSON.stringify(errorObject, null, 2));

                // @ts-expect-error - This is a valid response
                return res.json(errorObject).status(200);
            }

            const subscriptions = {};

            if (is_opted_in_to_marketing) {
                subscriptions.email = {
                    marketing: {
                        consent: 'SUBSCRIBED',
                    },
                };
            }

            // Considering that WhatsApp does not have field hosting, we will use SMS fields instead,
            // which means that SMS services will not be enabled in the future. 
            if (is_opted_in_to_sms) {
                subscriptions.whatsapp = {
                    marketing: { 
                        consent: 'SUBSCRIBED', 
                    }, 
                    transactional: { 
                        consent: 'SUBSCRIBED', 
                    } 
                };
            }

            if (subscriptions && Object.keys(subscriptions).length > 0) {
                try {
                    await klaviyoApi.subscribeProfiles({
                        data: {
                            type: 'profile-subscription-bulk-create-job',
                            attributes: {
                                profiles: {
                                    data: [
                                        {
                                            type: 'profile',
                                            attributes: {
                                                email: email,
                                                phone_number: subscriptions.whatsapp ? phone_number : null,
                                                subscriptions,
                                                
                                            },
                                        },
                                    ],
                                },
                            },
                        },
                    });
                } catch (e) {
                    const errorObject = {
                        event_name: 'profile.created',
                        message: e.message,
                        errors: e.response?.data.errors,
                    };

                    console.error(JSON.stringify(errorObject, null, 2));

                    // @ts-expect-error - This is a valid response
                    return res.json(errorObject).status(200);
                }
            }

            break;
        }

        case 'profile.get_user_info': {
            const email = data.customer?.email;

            if (!email || typeof email !== 'string') {
                return res.status(400).json({
                    event_name: data.action,
                    message: 'Email parameter is missing or invalid',
                });
            }

            try {
                const filter = new FilterBuilder().equals('email', email).build();
                const response = await klaviyoApi.getProfiles({
                    filter,
                    additionalFieldsProfile: ['subscriptions'],
                });
                const profiles = response.data;

                if (!profiles || profiles.length === 0) {
                    responseData = { profile_found: false };
                } else {
                    responseData = formatKlaviyoProfile(profiles[0]);
                }
            } catch (e) {
                const errorObject = {
                    event_name: data.action,
                    message: e.message,
                    errors: e.response?.data?.errors || e.body?.errors,
                };

                console.error(JSON.stringify(errorObject, null, 2));

                return res.status(200).json(errorObject);
            }

            break;
        }

        case 'profile.subscribe_marketing': {
            const email = data.subscribe_data?.customer?.email;
            const channels = data.subscribe_data?.channels;
            const phoneNumber = data.subscribe_data?.phone_number;

            const validChannels = ['email', 'whatsapp'];
            const activeChannels = Array.isArray(channels)
                ? channels.filter((channel) => validChannels.includes(channel))
                : [];

            if (!email || typeof email !== 'string') {
                return res.status(400).json({
                    event_name: data.action,
                    message: 'Email parameter is missing or invalid',
                });
            }

            if (activeChannels.length === 0) {
                return res.status(400).json({
                    event_name: data.action,
                    message: 'At least one valid channel ("email", "whatsapp") is required',
                });
            }

            try {
                const subscriptions = {};

                if (activeChannels.includes('email')) {
                    subscriptions.email = {
                        marketing: {
                            consent: 'SUBSCRIBED',
                        },
                    };
                }

                if (activeChannels.includes('whatsapp')) {
                    subscriptions.whatsapp = {
                        marketing: { 
                            consent: 'SUBSCRIBED', 
                        }, 
                    };
                }

                const payload = {
                    data: {
                        type: 'profile-subscription-bulk-create-job',
                        attributes: {
                            profiles: {
                                data: [
                                    {
                                        type: 'profile',
                                        attributes: {
                                            email,
                                            phone_number: subscriptions.whatsapp ? phoneNumber : null,
                                            subscriptions,
                                        },
                                    },
                                ],
                            },
                        },
                    },
                };

                await klaviyoApi.subscribeProfiles(payload);
            } catch (e) {
                const errorObject = {
                    event_name: data.action,
                    message: e.message,
                    errors: e.response?.data?.errors || e.body?.errors,
                };

                console.error(JSON.stringify(errorObject, null, 2));

                // @ts-expect-error - This is a valid response
                return res.json(errorObject).status(200);
            }

            break;
        }

        case 'profile.unsubscribe_marketing': {
            const email = data.unsubscribe_data?.customer?.email;
            const channels = data.unsubscribe_data?.channels;
            const phoneNumber = data.unsubscribe_data?.phone_number;

            const validChannels = ['email', 'whatsapp'];
            const activeChannels = Array.isArray(channels)
                ? channels.filter((channel) => validChannels.includes(channel))
                : [];

            if (!email || typeof email !== 'string') {
                return res.status(400).json({
                    event_name: data.action,
                    message: 'Email parameter is missing or invalid',
                });
            }

            if (activeChannels.length === 0) {
                return res.status(400).json({
                    event_name: data.action,
                    message: 'At least one valid channel ("email", "whatsapp") is required',
                });
            }

            try {
                const subscriptions = {};

                if (activeChannels.includes('email')) {
                    subscriptions.email = {
                        marketing: {
                            consent: 'UNSUBSCRIBED'
                        },
                    };
                }

                if (activeChannels.includes('whatsapp')) {
                    subscriptions.whatsapp = {
                        marketing: {
                            consent: 'UNSUBSCRIBED'
                        },
                    };
                }

                const payload = {
                    data: {
                        type: 'profile-subscription-bulk-delete-job',
                        attributes: {
                            profiles: {
                                data: [
                                    {
                                        type: 'profile',
                                        attributes: {
                                            email,
                                            phone_number: subscriptions.whatsapp ? phoneNumber : null,
                                            subscriptions,
                                        },
                                    },
                                ],
                            },
                        },
                    },
                };

                await klaviyoApi.unsubscribeProfiles(payload);
            } catch (e) {
                const errorObject = {
                    event_name: data.action,
                    message: e.message,
                    errors: e.response?.data?.errors || e.body?.errors,
                };

                console.error(JSON.stringify(errorObject, null, 2));

                // @ts-expect-error - This is a valid response
                return res.json(errorObject).status(200);
            }

            break;
        }

        case 'reservation.created': {
            // Handle booked_class event

            const reservation = data.reservation;
            const class_session = reservation.class_session;

            try {
                await Events.createEvent({
                    data: {
                        type: 'event',
                        attributes: {
                            metric: {
                                data: {
                                    type: 'metric',
                                    attributes: {
                                        name: data.action,
                                    },
                                },
                            },
                            properties: {
                                class_name: class_session.class_name,
                                class_type: class_session.class_type.name,
                                class_date_time: class_session.start_datetime,
                                trainer_name: class_session.instructors[0].name,
                                club: class_session.location.name,
                                is_booked_for_guest: reservation.guest_email ? true : false,
                                membership_used:
                                    reservation.membership_payments[0]?.contract_name,
                                package_used: reservation.credit_payments[0]?.package_name,
                                reservation_type: reservation.reservation_type,
                                spot_type: reservation.spot,
                                guest_email: reservation.guest_email,
                                reservation_id: reservation.id,
                                class_session_id: class_session.id,
                            },
                            profile: {
                                data: {
                                    type: 'profile',
                                    attributes: {
                                        email: data.reservation.customer.email,
                                    },
                                },
                            },
                        },
                    },
                });

            } catch (e) {
                const errorObject = {
                    event_name: data.action,
                    message: e.message,
                    errors: e.response?.data.errors,
                };

                console.error(JSON.stringify(errorObject, null, 2));

                // @ts-expect-error - This is a valid response
                return res.json(errorObject).status(200);
            }

            break;
        }

        case 'reservation.checkedin': {
            // Handle attended_class event
            const reservation = data.reservation;
            const class_session = reservation.class_session;
            const membership_payment = reservation.membership_payments[0];
            const credit_payment = reservation.credit_payments[0];

            let custom_properties = {};
            if (membership_payment) {
                custom_properties = await getMembershipCustomProperties(reservation.id);
            } else if (credit_payment) {
                custom_properties = await getPackageCustomProperties(reservation.id);
            }

            try {
                await Events.createEvent({
                    data: {
                        type: 'event',
                        attributes: {
                            metric: {
                                data: {
                                    type: 'metric',
                                    attributes: {
                                        name: data.action,
                                    },
                                },
                            },
                            properties: {
                                class_name: class_session.class_name,
                                class_type: class_session.class_type.name,
                                class_date_time: class_session.start_datetime,
                                trainer_name: class_session.instructors[0].name,
                                club: class_session.location.name,
                                reservation_id: reservation.id,
                                class_session_id: reservation.class_session.id,
                                package_name: credit_payment ? credit_payment.package_name : undefined,
                                membership_name: membership_payment ? membership_payment.name : undefined,

                                ...custom_properties
                            },
                            profile: {
                                data: {
                                    type: 'profile',
                                    attributes: {
                                        email: reservation.customer.email,
                                    },
                                },
                            },
                        },
                    },
                });
            } catch (e) {
                const errorObject = {
                    event_name: data.action,
                    message: e.message,
                    errors: e.response?.data.errors,
                };

                console.error(JSON.stringify(errorObject, null, 2));

                // @ts-expect-error - This is a valid response
                return res.json(errorObject).status(200);
            }

            break;
        }

        case 'reservation.cancelled': {
            // Handle class_cancelled event
            const reservation = data.reservation;
            const class_session = reservation.class_session;

            try {
                await Events.createEvent({
                    data: {
                        type: 'event',
                        attributes: {
                            metric: {
                                data: {
                                    type: 'metric',
                                    attributes: {
                                        name: data.action,
                                    },
                                },
                            },
                            properties: {
                                class_name: class_session.class_name,
                                class_type: class_session.class_type.name,
                                class_date_time: class_session.start_datetime,
                                trainer_name: class_session.instructors[0].name,
                                club: class_session.location.name,
                                reservation_id: reservation.id,
                                class_session_id: class_session.id,
                            },
                            profile: {
                                data: {
                                    type: 'profile',
                                    attributes: {
                                        email: data.reservation.customer.email,
                                    },
                                },
                            },
                        },
                    },
                });
            } catch (e) {
                const errorObject = {
                    event_name: data.action,
                    message: e.message,
                    errors: e.response?.data.errors,
                };

                console.error(JSON.stringify(errorObject, null, 2));

                // @ts-expect-error - This is a valid response
                return res.json(errorObject).status(200);
            }

            break;
        }

        case 'reservation.noshowed': {
            // Handle class_no_show event
            const reservation = data.reservation;
            const class_session = reservation.class_session;

            try {
                await Events.createEvent({
                    data: {
                        type: 'event',
                        attributes: {
                            metric: {
                                data: {
                                    type: 'metric',
                                    attributes: {
                                        name: data.action,
                                    },
                                },
                            },
                            properties: {
                                class_name: class_session.class_name,
                                class_type: class_session.class_type.name,
                                class_date_time: class_session.start_datetime,
                                trainer_name: class_session.instructors[0].name,
                                club: class_session.location.name,
                                reservation_id: reservation.id,
                                class_session_id: class_session.id,
                            },
                            profile: {
                                data: {
                                    type: 'profile',
                                    attributes: {
                                        email: data.reservation.customer.email,
                                    },
                                },
                            },
                        },
                    },
                });
            } catch (e) {
                const errorObject = {
                    event_name: data.action,
                    message: e.message,
                    errors: e.response?.data.errors,
                };

                console.error(JSON.stringify(errorObject, null, 2));

                // @ts-expect-error - This is a valid response
                return res.json(errorObject).status(200);
            }

            break;
        }

        case 'membership.purchased': {
            // Handle membership_purchased event
            const membership = data.membership;


            if (
                'membership_contract_id' in membership === false ||
                'order' in membership === false ||
                'start_type' in membership === false
            ) {
                return res.json({ error: 'Invalid `Membership` Payload' }).status(200);
            }

            const orderData = await marianaTekFetcher("orders/" + membership.order.id);

            try {
                await Events.createEvent({
                    data: {
                        type: 'event',
                        attributes: {
                            metric: {
                                data: {
                                    type: 'metric',
                                    attributes: {
                                        name: data.action,
                                    },
                                },
                            },
                            properties: {
                                id: membership.membership_contract_id,
                                name: membership.name,
                                start_date: membership.start_date,
                                end_date: membership.end_date,
                                purchase_date: membership.purchase_date,
                                start_type: membership.start_type,
                            },
                            value: membership.order.total,
                            value_currency: orderData?.data.attributes.currency,
                            profile: {
                                data: {
                                    type: 'profile',
                                    attributes: {
                                        email: data.membership.customer.email,
                                    },
                                },
                            },
                        },
                    },
                });
            } catch (e) {
                const errorObject = {
                    event_name: data.action,
                    message: e.message,
                    errors: e.response?.data.errors,
                };

                console.error(JSON.stringify(errorObject, null, 2));

                // @ts-expect-error - This is a valid response
                return res.json(errorObject).status(200);
            }

            break;
        }

        case 'membership.deactivated': {
            // Handle membership_cancelled event
            const membership = data.membership;

            const membershipInstance = await marianaTekFetcher("membership_instances/" + membership.id);

            try {
                await Events.createEvent({
                    data: {
                        type: 'event',
                        attributes: {
                            metric: {
                                data: {
                                    type: 'metric',
                                    attributes: {
                                        name: data.action,
                                    },
                                },
                            },
                            properties: {
                                name: membership.name,
                                start_date: membership.start_date,
                                end_date: membership.end_date,
                                id: membership.id,
                                cancellation_reason: membershipInstance?.data.attributes.cancellation_reason
                            },
                            value: membershipInstance?.data.attributes.renewal_rate,
                            value_currency: membershipInstance?.data.attributes.renewal_currency,
                            profile: {
                                data: {
                                    type: 'profile',
                                    attributes: {
                                        email: data.membership.customer.email,
                                    },
                                },
                            },
                        },
                    },
                });
            } catch (e) {
                const errorObject = {
                    event_name: data.action,
                    message: e.message,
                    errors: e.response?.data.errors,
                };

                console.error(JSON.stringify(errorObject, null, 2));

                // @ts-expect-error - This is a valid response
                return res.json(errorObject).status(200);
            }

            break;
        }

        case 'order.completed': {
            const isRefund = data.order.refund_sources.length > 0;
            const product = data.order.order_lines[0].product;
            const productType = product.product_type;

            if (isRefund || productType !== 'Credits') {
                break;
            }

            const packageData = await marianaTekFetcher("packages/" + product.id);
            const { expiration_interval, expiration_interval_length } = packageData?.data?.attributes ?? {};
            let orderDatetime = data.order.order_datetime;
            let expiryDate = null;

            if (
                ['DY', 'WK', 'MO', 'YR'].includes(expiration_interval) &&
                Number.isInteger(expiration_interval_length) &&
                expiration_interval_length >= 0
            ) {
                const date = new Date(orderDatetime);

                if (!Number.isNaN(date.getTime())) {
                    if (expiration_interval === 'DY' || expiration_interval === 'WK') {
                        const days = expiration_interval_length * (expiration_interval === 'WK' ? 7 : 1);
                        date.setUTCDate(date.getUTCDate() + days);
                    } else {
                        // Clamp month/year additions to the last day of the target month.
                        const originalDay = date.getUTCDate();
                        const months = expiration_interval_length * (expiration_interval === 'YR' ? 12 : 1);
                        date.setUTCDate(1);
                        date.setUTCMonth(date.getUTCMonth() + months);
                        const lastDay = new Date(date.getTime());
                        lastDay.setUTCMonth(lastDay.getUTCMonth() + 1, 0);
                        date.setUTCDate(Math.min(originalDay, lastDay.getUTCDate()));
                    }

                    if (!Number.isNaN(date.getTime())) {
                        expiryDate = date;
                    }
                }
            }

            const orderLine = data.order.order_lines[0];

            try {
                await Events.createEvent({
                    data: {
                        type: 'event',
                        attributes: {
                            metric: {
                                data: {
                                    type: 'metric',
                                    attributes: {
                                        name: 'package.purchased',
                                    },
                                },
                            },
                            properties: {
                                name: orderLine.product.name,
                                price: orderLine.line_total,
                                id: orderLine.product.id,
                                expiryDate,
                            },
                            value: orderLine.line_total,
                            valueCurrency: data.order.currency,
                            profile: {
                                data: {
                                    type: 'profile',
                                    attributes: {
                                        email: data.order.customer.email,
                                    },
                                },
                            },
                        },
                    },
                });
            } catch (e) {
                const errorObject = {
                    event_name: data.action,
                    message: e.message,
                    errors: e.response?.data.errors,
                };

                console.error(JSON.stringify(errorObject, null, 2));

                // @ts-expect-error - This is a valid response
                return res.json(errorObject).status(200);
            }

            break;
        }

        case "order.preordered_product": {
            const product = data.pre_ordered_product;

            try {
                await Events.createEvent({
                    data: {
                        type: 'event',
                        attributes: {
                            metric: {
                                data: {
                                    type: 'metric',
                                    attributes: {
                                        name: 'order.preordered_product',
                                    },
                                },
                            },
                            properties: {
                                id: product.id,
                                name: product.name,
                            },
                            value: product.value,
                            valueCurrency: product.value_currency,
                            profile: {
                                data: {
                                    type: 'profile',
                                    attributes: {
                                        email: product.customer.email,
                                    },
                                },
                            },
                        },
                    },
                });
            } catch (e) {
                const errorObject = {
                    event_name: data.action,
                    message: e.message,
                    errors: e.response?.data.errors,
                };

                console.error(JSON.stringify(errorObject, null, 2));

                // @ts-expect-error - This is a valid response
                return res.json(errorObject).status(200);
            }

            break;
        }

        case "order.completed_preorder": {

            const {
                product_name,
                product_id,
                class_name,
                trainer_name,
                club,
                discount_amount,
                discount_code,
                reservation_id,
                value,
                value_currency,
                customer
            } = data.pre_order_data;

            try {
                await Events.createEvent({
                    data: {
                        type: 'event',
                        attributes: {
                            metric: {
                                data: {
                                    type: 'metric',
                                    attributes: {
                                        name: 'order.completed_preorder',
                                    },
                                },
                            },
                            properties: {
                                product_name: product_name,
                                product_id: product_id,
                                class_name: class_name,
                                trainer_name: trainer_name,
                                club: club,
                                discount_amount: discount_amount,
                                discount_code: discount_code,
                                reservation_id: reservation_id,
                            },
                            value: value,
                            valueCurrency: value_currency,
                            profile: {
                                data: {
                                    type: 'profile',
                                    attributes: {
                                        email: customer.email,
                                    },
                                },
                            },
                        },
                    },
                });
            } catch (e) {
                const errorObject = {
                    event_name: data.action,
                    message: e.message,
                    errors: e.response?.data.errors,
                };

                console.error(JSON.stringify(errorObject, null, 2));

                // @ts-expect-error - This is a valid response
                return res.json(errorObject).status(200);
            }

            break;
        }

        case "analytics.send_event": {
            const eventName = data.event_name;
            const email = data.email;
            const properties = data.properties;

            try {
                await Events.createEvent({
                    data: {
                        type: 'event',
                        attributes: {
                            metric: {
                                data: {
                                    type: 'metric',
                                    attributes: {
                                        name: eventName,
                                    },
                                },
                            },
                            properties: properties,
                            profile: {
                                data: {
                                    type: 'profile',
                                    attributes: {
                                        email: email,
                                    },
                                },
                            },
                        },
                    },
                });
            } catch (e) {
                const errorObject = {
                    event_name: eventName,
                    message: e.message,
                    errors: e.response?.data.errors,
                };

                console.error(JSON.stringify(errorObject, null, 2));
                return res.json(errorObject).status(200);
            }

            break;
        }

        default:
            throw new Error('Unsupported Event');
    }

    res.json({ success: true, data: responseData }).status(200);
};

/**
 * Fetches data from the Mariana Tek API.
 *
 * @async
 * @function marianaTekFetcher
 * @param {string} path - The API endpoint path to append to the base URL.
 * @returns {Promise<Object|null>} The parsed JSON response if successful, otherwise `null`.
 *
 * @throws {Error} Logs an error if the request fails or if JSON parsing encounters an issue.
 */
async function marianaTekFetcher(path) {

    try {
        const response = await fetch(process.env.MT_API_ENDPOINT + path, {
            method: "GET",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${process.env.MT_ADMIN_TOKEN}`,
            }
        });

        if (!response.ok) {
            console.error("Failed to fetch MT data => ", response.status);
            return null;
        }


        return await response.json();
    } catch (e) {
        console.log("Failed to parse MT response => ", e)

        return null;
    }

}

const safeDate = (str) => {
    if (!str) return null;
    const d = new Date(typeof str === 'string' ? str.replace(' ', 'T') : str);
    return isNaN(d.getTime()) ? null : d;
};

const toDayMs = (d) => {
    if (!d) return null;
    return new Date(d.toISOString().slice(0, 10)).getTime();
};

const MS_PER_DAY = 1000 * 60 * 60 * 24;

async function getMembershipCustomProperties(reservationId) {
    let custom_properties = {};

    try {
        const reservationData = await marianaTekFetcher(
            `reservations/${reservationId}?include=membership_transactions.membership_instance.current_membership_transaction`
        );

        const membershipInstance = reservationData?.included?.find(
            item => item.type === 'membership_instances'
        );

        const parentMembershipTransactionId = membershipInstance?.relationships?.current_membership_transaction?.data?.id;
        if (parentMembershipTransactionId) {
            const membershipTransaction = reservationData?.included?.find(
                item => item.type === 'membership_transactions' && parentMembershipTransactionId === item.id
            );
            if (membershipTransaction) {
                const membershipInstanceAttrs = membershipInstance.attributes;
                const membershipContractId = membershipInstance?.relationships?.membership_product?.data?.id || null;
                const membershipName = membershipInstanceAttrs.membership_name;
                const usageIntervalLimit = membershipInstanceAttrs.usage_interval_limit;
                const commitmentLength = membershipInstanceAttrs.commitment_length ?? 0;
                const renewalCount = membershipInstanceAttrs.renewal_count ?? 0;
                const isRollingContract = commitmentLength === 0 || renewalCount > commitmentLength;

                const membershipTransactionAttrs = membershipTransaction.attributes;

                const sessionsUsed = membershipTransactionAttrs.usage_count ?? 0;
                let totalSessionsIncluded;
                let remaining = membershipTransactionAttrs.remaining_usage_count;
                if (remaining !== null) {
                    totalSessionsIncluded = sessionsUsed + remaining;
                } else if (usageIntervalLimit !== null) {
                    totalSessionsIncluded = usageIntervalLimit
                } else {
                    const match = membershipName.match(/(\d+)\s*(?:Session?|Class(?:es)?)/i);
                    totalSessionsIncluded = match ? parseInt(match[1], 10) : 31;
                }
                remaining = totalSessionsIncluded - sessionsUsed;

                const isUnlimited = totalSessionsIncluded >= 28;
                const cycleStartDate = safeDate(membershipTransactionAttrs.payment_interval_start_date);
                const cycleEndDate = safeDate(membershipTransactionAttrs.payment_interval_end_date);
                const checkInDate = safeDate(reservationData?.data?.attributes?.check_in_date);

                let daysElapsed = 0;
                let timeElapsedPct = 0;

                if (cycleStartDate && checkInDate) {
                    const startDayMs = toDayMs(cycleStartDate);
                    const endDayMs = toDayMs(cycleEndDate);
                    const checkInDayMs = toDayMs(checkInDate);

                    daysElapsed = Math.max(0, Math.round((checkInDayMs - startDayMs) / MS_PER_DAY));

                    const totalDays = (cycleEndDate && cycleEndDate > cycleStartDate)
                        ? Math.round((endDayMs - startDayMs) / MS_PER_DAY)
                        : 31;

                    timeElapsedPct = Math.min(100, Math.round((daysElapsed / totalDays) * 100));
                }

                const usagePct = totalSessionsIncluded > 0 ? (sessionsUsed / totalSessionsIncluded) : 0;
                const sessionUsedPct = Math.min(100, Math.round(usagePct * 100));

                custom_properties = {
                    type: 'membership',

                    membership_contract_id: membershipContractId,
                    membership_instance_id: membershipInstance.id,
                    membership_start_date: safeDate(membershipInstanceAttrs.start_date),
                    membership_instance_name: membershipName,
                    commitment_length: commitmentLength,
                    is_rolling_contract: isRollingContract,

                    current_cycle_start_date: cycleStartDate,
                    current_cycle_end_date: cycleEndDate,
                    cycle_days_elapsed: daysElapsed,
                    cycle_elapsed_percentage: timeElapsedPct,
                    total_sessions_included: totalSessionsIncluded,
                    sessions_remaining: remaining,
                    session_count: sessionsUsed,
                    session_usage_percentage: sessionUsedPct,
                    is_unlimited: isUnlimited
                };
            }
        }
        
    } catch (e) {
        console.error("Failed to get membership custom properties => ", e);
    }

    return custom_properties;
}

async function getPackageCustomProperties(reservationId, fallbackRemaining) {
    let custom_properties = {};

    try {
        const reservationData = await marianaTekFetcher(
            `reservations/${reservationId}?include=credit_transactions`
        );

        const creditTransaction = reservationData?.included?.find(item => item.type === 'credit_transactions');
        const parentCreditTransactionId = creditTransaction?.relationships?.parent_credit_transaction?.data?.id;
        if (parentCreditTransactionId) {
            const parentCreditTransaction = await marianaTekFetcher(`credit_transactions/${parentCreditTransactionId}`);
            const attrs = parentCreditTransaction?.data?.attributes || parentCreditTransaction?.attributes;
            if (attrs) {
                const totalSessionsIncluded = attrs.transaction_amount ?? 0;
                const remaining = fallbackRemaining ?? attrs.remaining_credits_cache ?? 0;
                const sessionsUsed = Math.max(0, totalSessionsIncluded - remaining);

                const startDate = safeDate(attrs.transaction_datetime);
                const endDate = safeDate(attrs.expiration_datetime);
                const checkInDate = safeDate(reservationData?.data?.attributes?.check_in_date);

                let daysElapsed = 0;
                let timeElapsedPct = 0;

                if (startDate && checkInDate) {
                    const startDayMs = toDayMs(startDate);
                    const endDayMs = toDayMs(endDate);
                    const checkInDayMs = toDayMs(checkInDate);

                    daysElapsed = Math.max(0, Math.round((checkInDayMs - startDayMs) / MS_PER_DAY));

                    const totalDays = Math.round((endDayMs - startDayMs) / MS_PER_DAY)

                    timeElapsedPct = Math.min(100, Math.round((daysElapsed / totalDays) * 100));
                }

                const usagePct = totalSessionsIncluded > 0 ? (sessionsUsed / totalSessionsIncluded) : 0;
                const sessionUsedPct = Math.min(100, Math.round(usagePct * 100));

                custom_properties = {
                    type: 'package',
                    package_start_date: startDate ? startDate.toISOString() : null,
                    package_expiry_date: endDate ? endDate.toISOString() : null,
                    period_elapsed_percentage: timeElapsedPct,
                    total_sessions_included: totalSessionsIncluded,
                    sessions_remaining: remaining,
                    session_count: sessionsUsed,
                    session_usage_percentage: sessionUsedPct,
                };
            }
        }
    } catch (e) {
        console.error("Failed to get package custom properties => ", e.message || e);
    }

    return custom_properties;
}

function formatKlaviyoProfile(rawProfile) {
    const attributes = rawProfile.attributes || {};

    return {
        profile_found: true,
        profile: {
            id: rawProfile.id,
            external_id: attributes.externalId || null,
            email: attributes.email || null,
            phone_number: attributes.phone_number || null,
        },
        subscriptions: attributes.subscriptions || {},
        properties: attributes.properties || {},
    };
}

const BASE_URL = "https://a.klaviyo.com/api";
const REVISION = "2026-07-15";
const DATA_SOURCE_ID = process.env["KLAVIYO_DATA_SOURCE_ID"];
const OBJECT_TYPE_ID = process.env["KLAVIYO_OBJECT_TYPE_ID"];

/**
 * Generic Klaviyo API helper using native `fetch`.
 *
 * Centralizes the common headers (auth, revision, content-type) and exposes
 * methods for endpoints where the SDK's older version fails to serialize
 * payloads correctly (e.g. `subscriptions.whatsapp`).
 *
 * The API key is read from `process.env.KLAVIYO_PRIVATE_API_KEY` internally,
 * so callers don't need to pass it.
 */
class KlaviyoApi {
    constructor(apiKey = process.env["KLAVIYO_PRIVATE_API_KEY"]) {
        this.apiKey = apiKey;
    }

    /** Common request headers shared by every Klaviyo endpoint. */
    get headers() {
        return {
            accept: 'application/vnd.api+json',
            revision: REVISION,
            'content-type': 'application/vnd.api+json',
            Authorization: `Klaviyo-API-Key ${this.apiKey}`
        };
    }

    /**
     * Internal POST helper. Throws an error (with `response.data` / `body`
     * attached) when the response is not OK, so existing try/catch blocks that
     * read `e.response?.data.errors` keep working.
     */
    async post(path, payload) {
        const res = await fetch(`${BASE_URL}${path}`, {
            method: 'POST',
            headers: this.headers,
            body: JSON.stringify(payload)
        });

        if (!res.ok) {
            const body = await res.json().catch(() => null);
            const err = new Error(`Klaviyo ${path} failed: ${res.status}`);
            err.response = { data: body };
            err.body = body;
            throw err;
        }

        return res;
    }

    /**
     * Internal GET helper. `query` is an object of query-string params; arrays
     * become repeated keys (`additional-fields[profile]=a&additional-fields[profile]=b`).
     * Throws the same shaped error as `post()`.
     */
    async get(path, query = {}) {
        const parts = [];
        for (const [key, value] of Object.entries(query)) {
            if (value == null) continue;
            if (Array.isArray(value)) {
                for (const v of value) {
                    parts.push(
                        encodeURIComponent(key) + '=' + encodeURIComponent(String(v))
                    );
                }
            } else {
                parts.push(
                    encodeURIComponent(key) + '=' + encodeURIComponent(String(value))
                );
            }
        }
        const url = `${BASE_URL}${path}${parts.length ? '?' + parts.join('&') : ''}`;
        
        const res = await fetch(url, {
            method: 'GET',
            headers: this.headers
        });

        if (!res.ok) {
            const body = await res.json().catch(() => null);
            const err = new Error(`Klaviyo ${path} failed: ${res.status}`);
            err.response = { data: body };
            err.body = body;
            throw err;
        }

        return res.json();
    }

    // ---- Data Source Records ----

    buildDataSourceRecordsPayload(records) {
        return {
            data: {
                type: "data-source-record-bulk-create-job",
                attributes: {
                    "data-source-records": {
                        data: records
                    }
                },
                relationships: {
                    "data-source": {
                        data: {
                            type: "data-source",
                            id: DATA_SOURCE_ID
                        }
                    }
                }
            }
        };
    }

    /** POST a data-source-record bulk-create job. */
    async createDataSourceRecords(records) {
        return this.post(
            '/data-source-record-bulk-create-jobs',
            this.buildDataSourceRecordsPayload(records)
        );
    }

    /**
     * Delete records via the object-records bulk-delete job.
     * Klaviyo has no data-source-record delete endpoint; deletion must go
     * through /object-record-bulk-delete-jobs with composite record ids of
     * the form "{object-type-id}:::{record-id}".
     */
    async deleteDataSourceRecords(recordIds) {
        if (!recordIds || recordIds.length === 0) return null;
        const compositeIds = recordIds.map((id) => `${OBJECT_TYPE_ID}:::${id}`);
        const payload = {
            data: {
                type: "object-record-bulk-delete-job",
                attributes: {},
                relationships: {
                    "object-records": {
                        data: compositeIds.map((id) => ({
                            type: "object-record",
                            id
                        }))
                    }
                }
            }
        };
        return this.post('/object-record-bulk-delete-jobs', payload);
    }

    /**
     * GET /profiles — same-ish signature as the SDK's Profiles.getProfiles so
     * callers can keep using FilterBuilder and additionalFieldsProfile without
     * wondering about query-string names.
     */
    async getProfiles({ filter, additionalFieldsProfile = [] } = {}) {
        const query = {};
        if (filter) query.filter = filter;
        if (additionalFieldsProfile.length > 0) {
            query['additional-fields[profile]'] = additionalFieldsProfile;
        }
        return this.get('/profiles', query);
    }

    /** POST a profile-subscription bulk-create job. */
    async subscribeProfiles(payload) {
        return this.post('/profile-subscription-bulk-create-jobs', payload);
    }

    /** POST a profile-subscription bulk-delete job. */
    async unsubscribeProfiles(payload) {
        return this.post('/profile-subscription-bulk-delete-jobs', payload);
    }
}

/**
 * This is a temporary workaround to create custom objects in Klaviyo. 
 * Once the package in NapkinIO is updated we will not need this anymmore.
 */
async function createAndUpdateMemberhipOrPackageRecords(data) {
    let user_id = "";
    let user_email = "";

    /**
     * Extract User ID and User Email
     */
    switch (data.action) {
        case 'profile.created': {
            user_id = data.profile.id;
            user_email = data.profile.email;

            break;
        }
        case "profile.get_user_info": {

            break;
        }
        case "profile.subscribe_marketing": {

            break;
        }
        case "profile.unsubscribe_marketing": {

            break;
        }
        case "reservation.created": {
            user_id = data.reservation.customer.id;
            user_email = data.reservation.customer.email;

            break;
        }
        case "reservation.checkedin": {
            user_id = data.reservation.customer.id;
            user_email = data.reservation.customer.email;

            break;
        }
        case "reservation.cancelled": {
            user_id = data.reservation.customer.id;
            user_email = data.reservation.customer.email;

            break;
        }
        case "reservation.noshowed": {
            user_id = data.reservation.customer.id;
            user_email = data.reservation.customer.email;

            break;
        }
        case "membership.purchased": {
            user_id = data.membership.customer.id;
            user_email = data.membership.customer.email;

            break;
        }
        case "membership.deactivated": {
            user_id = data.membership.customer.id;
            user_email = data.membership.customer.email;

            break;
        }
        case "order.completed": {
            user_id = data.order.customer.id;
            user_email = data.order.customer.email;

            break;
        }
        case "order.preordered_product": {

            break;
        }
        case "order.completed_preorder": {

            break;
        }
    }

    if (!user_id || !user_email) {
        console.log("Failed to find user id/email => ", data.action);
        return;
    }

    /**
     * Fetch membership instances (with current transaction included) and all
     * credit transactions for this user from MT, in parallel.
     */
    const fetchAllCreditTransactions = async () => {
        const rows = [];
        let page = 1;
        let totalPages = 1;
        do {
            const res = await marianaTekFetcher(
                `credit_transactions?user=${user_id}&page_size=100&page=${page}`
            );
            const data = res?.data || [];
            rows.push(...data);
            totalPages = res?.meta?.pagination?.pages || 1;
            page++;
        } while (page <= totalPages);
        return rows;
    };

    const [allMembershipsResults, creditTransactions] = await Promise.all([
        marianaTekFetcher(
            `membership_instances?user=${user_id}&include=current_membership_transaction`
        ),
        fetchAllCreditTransactions(),
    ]);

    const memberships = allMembershipsResults?.data || [];
    const includedTx = new Map(
        (allMembershipsResults?.included || [])
            .filter((i) => i.type === 'membership_transactions')
            .map((i) => [i.id, i.attributes])
    );

    // Collect positive (purchase) package dates for has_additional_package_purchase.
    const packagePurchaseDates = creditTransactions
        .filter((t) => t.relationships?.parent_credit_transaction?.data === null)
        .map((t) => t.attributes.transaction_datetime)
        .filter(Boolean);

    // --- helpers -----------------------------------------------------------
    const COMMITMENT_INTERVALS = new Set(['DY', 'WK', 'MO', 'YR']);
    const SESSION_NAME_RE = /(\d+)\s*(?:Session?|Class(?:es)?)/i;
    const NOW_MS = Date.now();

    const computeCommitmentExpiry = (attrs) => {
        const { commitment_length: length, payment_interval: interval, start_date: start } = attrs;
        if (!(length > 0) || !COMMITMENT_INTERVALS.has(interval)) return null;
        const date = safeDate(start);
        if (!date) return null;
        if (interval === 'DY' || interval === 'WK') {
            date.setUTCDate(date.getUTCDate() + length * (interval === 'WK' ? 7 : 1));
        } else {
            const originalDay = date.getUTCDate();
            const months = length * (interval === 'YR' ? 12 : 1);
            date.setUTCDate(1);
            date.setUTCMonth(date.getUTCMonth() + months);
            const lastDay = new Date(date.getTime());
            lastDay.setUTCMonth(lastDay.getUTCMonth() + 1, 0);
            date.setUTCDate(Math.min(originalDay, lastDay.getUTCDate()));
        }
        return date.toISOString().replace(/\.000Z$/, 'Z');
    };

    const resolveExpiryDate = (attrs) => {
        const computed = computeCommitmentExpiry(attrs);
        if (computed && new Date(computed).getTime() > NOW_MS) return computed;
        return attrs.next_charge_date ?? attrs.payment_interval_end_date ?? null;
    };

    const computeSessionUsage = (attrs, tx) => {
        const used = tx.usage_count ?? 0;
        const remainingRaw = tx.remaining_usage_count;
        let total;
        if (remainingRaw != null) total = used + remainingRaw;
        else if (attrs.usage_interval_limit != null) total = attrs.usage_interval_limit;
        else {
            const m = (attrs.membership_name || '').match(SESSION_NAME_RE);
            total = m ? parseInt(m[1], 10) : 31;
        }
        return {
            total,
            remaining: Math.max(0, total - used),
            pct: total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0,
        };
    };

    const hasPurchaseInCycle = (cycleStart, cycleEnd) => {
        if (!cycleStart) return false;
        const start = cycleStart.getTime();
        const end = cycleEnd ? cycleEnd.getTime() : Infinity;
        return packagePurchaseDates.some((dt) => {
            const t = safeDate(dt)?.getTime();
            return t != null && t >= start && t <= end;
        });
    };

    // Wrap an object_record + email relationship into a Klaviyo data-source-record.
    const toRecord = (objectRecord, email) => ({
        type: "data-source-record",
        attributes: {
            record: {
                object_record: objectRecord,
                relationships: {
                    Email: [{ id: email, email }]
                }
            }
        }
    });

    // --- build memberships -------------------------------------------------
    const activeMembershipRecords = [];
    const inactiveMembershipIds = [];

    for (const m of memberships) {
        const attrs = m.attributes;
        const isActive = attrs.status === 'active';
        const txId = m.relationships?.current_membership_transaction?.data?.id;
        const tx = (txId && includedTx.get(txId)) || {};

        if (!isActive) {
            inactiveMembershipIds.push(m.id);
            continue;
        }

        const cycleStartRaw = tx.payment_interval_start_date || attrs.payment_interval_start_date;
        const cycleEndRaw = tx.payment_interval_end_date || attrs.payment_interval_end_date;
        const cycleStart = safeDate(cycleStartRaw);
        const cycleEnd = safeDate(cycleEndRaw);
        const usage = computeSessionUsage(attrs, tx);
        const hasPkg = hasPurchaseInCycle(cycleStart, cycleEnd);
        const expiryDate = resolveExpiryDate(attrs);
        const expired = expiryDate ? new Date(expiryDate).getTime() <= NOW_MS : false;

        // Treat expired or fully-consumed memberships as inactive so they
        // are deleted from Klaviyo instead of being re-upserted.
        if (expired || usage.remaining === 0) {
            inactiveMembershipIds.push(m.id);
            continue;
        }

        activeMembershipRecords.push(toRecord({
            id: m.id,
            name: attrs.membership_name,
            start_date: attrs.start_date || attrs.calculated_start_datetime || null,
            expiry_date: expiryDate,
            is_expired: false,
            membership_status: attrs.status,
            type: 'membership',
            current_cycle_end_date: cycleEndRaw || null,
            session_usage_percentage: usage.pct,
            session_remaining: usage.remaining,
            total_sessions_included: usage.total,
            has_additional_package_purchase: hasPkg,
        }, user_email));
    }

    // --- build packages (parent credit transactions only) ------------------
    const activePackageRecords = [];
    const inactivePackageIds = [];

    for (const t of creditTransactions) {
        if (t.relationships?.parent_credit_transaction?.data !== null) continue;
        const attrs = t.attributes;
        const expiry = attrs.expiration_datetime ?? null;
        const expiredByDate = expiry ? new Date(expiry).getTime() <= NOW_MS : false;
        const isActive = !attrs.is_expired && !expiredByDate;

        const remaining = attrs.remaining_credits_cache ?? 0;
        if (!isActive || remaining === 0) {
            inactivePackageIds.push(t.id);
            continue;
        }

        const total = attrs.transaction_amount ?? 0;
        const used = Math.max(0, total - remaining);
        const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;

        activePackageRecords.push(toRecord({
            id: t.id,
            name: attrs.credit_name,
            start_date: attrs.transaction_datetime ?? null,
            expiry_date: attrs.expiration_datetime ?? null,
            is_expired: false,
            membership_status: 'active',
            type: 'package',
            current_cycle_end_date: attrs.expiration_datetime ?? null,
            session_usage_percentage: pct,
            session_remaining: remaining,
            total_sessions_included: total,
            has_additional_package_purchase: false,
        }, user_email));
    }

    // --- push to Klaviyo: upsert active, delete inactive -------------------
    const klaviyoApi = new KlaviyoApi();
    const recordsToUpsert = [...activeMembershipRecords, ...activePackageRecords];
    const idsToDelete = [...inactiveMembershipIds, ...inactivePackageIds];

    if (recordsToUpsert.length > 0) {
        try {
            await klaviyoApi.createDataSourceRecords(recordsToUpsert);
        } catch (e) {
            console.error(
                "Failed to upsert data source records",
                e.response?.data || e.body || e.message
            );
        }
    }

    if (idsToDelete.length > 0) {
        try {
            await klaviyoApi.deleteDataSourceRecords(idsToDelete);
        } catch (e) {
            console.error(
                "Failed to delete data source records",
                e.response?.data || e.body || e.message
            );
        }
    }
}


/**
 * The following code contains yup object definitions to validate our payloads
 */
const profileSchema = object({
    id: string().required(),
    address_line1: string().nullable(),
    birth_date: string().nullable(),
    city: string().nullable(),
    country: string().nullable(),
    email: string().email().nullable(),
    first_name: string().required(),
    full_name: string().required(),
    gender: string().nullable(),
    home_location: object({
        id: string().required(),
        type: string().required(),
        name: string().required(),
        timezone: string().required(),
        region: object({
            id: string().required(),
            type: string().required(),
            name: string().required(),
        }).required(),
    }).required(),
    is_opted_in_to_marketing: boolean().required(),
    is_opted_in_to_sms: boolean().required(),
    last_name: string().required(),
    phone_number: string().nullable(),
    postal_code: string().nullable(),
});

const classSessionSchema = object({
    id: number().required(),
    type: string().required(),
    cancellation_datetime: string().nullable(),
    class_type: object({
        id: number().required(),
        type: string().required(),
        duration: number().required(),
        is_live_stream: boolean(),
        name: string().required(),
    }).required(),
    class_name: string().required(),
    end_datetime: string().required(),
    instructors: array()
        .of(
            object({
                id: number().required(),
                type: string().required(),
                name: string().required(),
            }).required()
        )
        .nullable(),
    location: object({
        id: string().required(),
        type: string().required(),
        name: string().required(),
        timezone: string().required(),
        region: object({
            id: string().required(),
            type: string().required(),
            name: string().required(),
        }).required(),
    }).required(),
    start_date: string().required(),
    start_datetime: string().required(),
    start_time: string().required(),
});

const creditPaymentsSchema = array().of(
    object({
        expiration_date: string(),
        is_expired: boolean().required(),
        name: string().required(),
        package_name: string().required(),
        package_source: string().nullable(),
        remaining: number().nullable(),
    }).required()
);

const membershipPaymentsSchema = array().of(
    object({
        end_date: string().nullable(),
        name: string().required(),
        remaining_renewals: string().nullable(),
    }).required()
);

const reservationSchema = object({
    id: number().required(),
    type: string().required(),
    class_session: classSessionSchema,
    credit_payments: creditPaymentsSchema,
    membership_payments: membershipPaymentsSchema,
    customer: profileSchema,
    guest_email: string().nullable(),
    payer: profileSchema,
    reservation_type: string().required(),
    spot: object({
        id: string(),
        type: string(),
        name: string(),
    }).nullable(),
    status: string().required(),
});

const orderSchema = object({
    id: number(),
    type: string(),
    currency: string(),
    customer: profileSchema,
    discount_total: number(),
    discounts: array().of(
        object({
            name: string(),
            amount: number(),
        })
    ),
    location: object({
        id: string().required(),
        type: string().required(),
        name: string().required(),
        timezone: string().required(),
        region: object({
            id: string().required(),
            type: string().required(),
            name: string().required(),
        }).required(),
    }).required(),
    number: string(),
    order_datetime: string(),
    order_lines: array().of(
        object({
            id: number(),
            type: string(),
            line_subtotal: number(),
            line_total: number(),
            options: array()
                .of(
                    object({
                        name: string().required(),
                        value: string().required(),
                    })
                )
                .nullable(),
            product: object({
                id: number().required(),
                type: string().required(),
                name: string().required(),
                product_type: string().required(),
            }).required(),
            quantity: number().required(),
            status: string().required(),
            unit_subtotal: number().required(),
            unit_total: number().required(),
        })
    ),
    payment_sources: array()
        .of(
            object({
                name: string(),
                amount: number(),
                bankcard_id: string().nullable(),
            })
        )
        .nullable(),
    refund_sources: array()
        .of(
            object({
                name: string(),
                amount: number(),
                bankcard_id: string().nullable(),
            })
        )
        .nullable(),
    status: string(),
    subtotal: number(),
    total: number().required(),
});

const membershipOrderSchema = object({
    id: number(),
    number: string(),
    order_datetime: string(),
    payment_sources: array()
        .of(
            object({
                name: string().required(),
                amount: number().required(),
                bankcard_id: string().nullable(),
            }).required()
        )
        .nullable(),
    purchase_source: string().nullable(),
    status: string(),
    subtotal: number(),
    total: number(),
});

const membershipSchema = object({
    id: number().required(),
    type: string().required(),
    customer: profileSchema.required(),
    end_date: string().nullable(),

    name: string().required(),
    purchase_date: string().required(),
    purchase_location: string().required(),
    start_date: string().nullable(),
    status: string().required(),

    // These are not availble in `membership.purchased`
    freeze_start_date: string().nullable(),
    freeze_end_date: string().nullable(),

    // These are only available if the action is `memberhip.purchased`
    billing_type: string().nullable(),
    purchase_location_id: string(),
    membership_contract_id: string(),
    order: membershipOrderSchema,
    start_type: string(),
});

const preOrderedProduct = object({
    id: string().required(),
    name: string().required(),
    value: string().required(),
    value_currency: string().required(),
    customer: object({
        email: string().email().nullable(),
    }).required()
})

const preOrderData = object({
    product_name: string().required(),
    product_id: string().required(),
    class_name: string().required(),
    class_date: string().required(),
    trainer_name: string(),
    club: string().required(),
    discount_amount: number(),
    discount_code: string(),
    reservation_id: string().required(),
    value: number().required(),
    value_currency: string().required(),
    customer: object({
        email: string().email().nullable(),
    }).required()
})

const customerSchema = object({
    email: string().email('Invalid email format').required('Email is required'),
});

const channelsSchema = array()
    .of(string().oneOf(['email', 'whatsapp'], 'Invalid channel'))
    .min(1, 'At least one valid channel is required')
    .required('Channels are required');

const subscribeSchema = object({
    customer: customerSchema,
    channels: channelsSchema,
    phone_number: string().optional().nullable(),
});

const unsubscribeSchema = object({
    customer: customerSchema,
    channels: channelsSchema,
    phone_number: string().optional().nullable(),
});


const requestBodySchema = object({
    action: mixed()
        .oneOf([
            'profile.created',
            "profile.get_user_info",
            "profile.subscribe_marketing",
            "profile.unsubscribe_marketing",
            'reservation.created',
            'reservation.checkedin',
            'reservation.cancelled',
            'reservation.noshowed',
            'membership.purchased',
            'membership.deactivated',
            'order.completed',
            'order.completed_preorder',
            'order.preordered_product',
            'analytics.send_event',
        ])
        .required()
        .typeError('Action is required'),
    tenant: string().required(),
    event_datetime: string().required(),
    profile: profileSchema.when('action', (action, schema) => {
        if (typeof action !== 'string') {
            throw new Error('Invalid action');
        }

        if (action === 'profile.created') {
            return schema.required();
        } else {
            return schema.strip();
        }
    }),
    reservation: reservationSchema.when('action', (action, schema) => {
        if (typeof action !== 'string') {
            throw new Error('Invalid action');
        }

        if (
            [
                'reservation.created',
                'reservation.checkedin',
                'reservation.cancelled',
                'reservation.noshowed',
            ].includes(action)
        ) {
            return schema.required();
        } else {
            return schema.strip();
        }
    }),
    membership: membershipSchema.when('action', (action, schema) => {
        if (typeof action !== 'string') {
            throw new Error('Invalid action');
        }

        if (['membership.purchased', 'membership.deactivated'].includes(action)) {
            return schema.required();
        } else {
            return schema.strip();
        }
    }),
    order: orderSchema.when('action', (action, schema) => {
        if (typeof action !== 'string') {
            throw new Error('Invalid action');
        }

        if (action === 'order.completed') {
            return schema.required();
        } else {
            return schema.strip();
        }
    }),
    pre_ordered_product: preOrderedProduct.when('action', (action, schema) => {
        if (typeof action !== 'string') {
            throw new Error('Invalid action');
        }

        if (action === 'order.preordered_product') {
            return schema.required();
        } else {
            return schema.strip();
        }
    }),
    pre_order_data: preOrderData.when('action', (action, schema) => {
        if (typeof action !== 'string') {
            throw new Error('Invalid action');
        }

        if (action === 'order.completed_preorder') {
            return schema.required();
        } else {
            return schema.strip();
        }
    }),
    customer: customerSchema.when('action', (action, schema) => {
        if (typeof action !== 'string') {
            throw new Error('Invalid action');
        }

        if (action === 'profile.get_user_info') {
            return schema.required();
        }

        return schema.strip();
    }),
    subscribe_data: subscribeSchema.when('action', (action, schema) => {
        if (typeof action !== 'string') {
            throw new Error('Invalid action');
        }

        if (action === 'profile.subscribe_marketing') {
            return schema.required();
        }

        return schema.strip();
    }),
    unsubscribe_data: unsubscribeSchema.when('action', (action, schema) => {
        if (typeof action !== 'string') {
            throw new Error('Invalid action');
        }

        if (action === 'profile.unsubscribe_marketing') {
            return schema.required();
        }

        return schema.strip();
    }),
});
