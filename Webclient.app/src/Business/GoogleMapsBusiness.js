export const GoogleMapsBusiness={

    CreateRoutesUrlFromPoint:(_geometry)=>{
        const _lat=_geometry.latitude;
        const _lng=_geometry.longitude;
        let url = "https://www.google.com.tr/maps?saddr=My+Location&daddr=" + _lat + "," + _lng;
        return url;
        //return GoogleMapsBusiness.CreateRoutesUrlFromLatLng(lat,lng);
    },

    CreateStreetViewUrlFromPoint:(_geometry)=>{
        const _lat=_geometry.latitude;
        const _lng=_geometry.longitude;
        let url="https://maps.google.com/maps?q=&layer=c&cbll="+_lat+","+_lng;
        return url;
    }

}